/**
 * A bounded zip reader that accepts exactly one zip layout (deep-dive
 * decision 06 §E1 "parser limits" and "one accepted zip layout", amendment
 * rows A4 and A6; batch 16 lane 16A). The upload wrapper uses it for the
 * Office Open XML rule (utils/upload-ooxml.ts) and for the PDF polyglot
 * refusal (utils/upload-guard.ts).
 *
 * WHY ONE LAYOUT. Readers disagree about which zip a file is: Office and
 * this reader start at the end record and the central directory, file-type
 * (and Strapi's validateFile with it) walks the local headers from offset
 * 0, others search for the first local header. A file whose central
 * directory and local headers describe the same entries in the same bytes,
 * with nothing before, between or after them, is the same zip for all of
 * them. Anything else is refused:
 *   - no prefix: the first local header is at offset 0;
 *   - one end record, ending exactly at the end of the file (its comment
 *     included), whose comment holds no second end-record signature;
 *   - the central directory starts where the end record says and ends
 *     exactly where the end record begins; the entry counts agree;
 *   - sorted by local-header offset, the entries tile the bytes from 0 to
 *     the directory: each local header, name, extra field, data and
 *     optional data descriptor ends where the next entry begins;
 *   - each local header agrees with its directory record in the name
 *     bytes, the method and the flags, and in the CRC and sizes unless bit
 *     3 (data descriptor) is set; a data descriptor (with or without its
 *     signature) carries 32-bit sizes and agrees with the directory;
 *   - methods 0 (stored) and 8 (deflate) only;
 *   - names in printable ASCII (0x21-0x7E), `/` the only separator, no `\`,
 *     no `%`, no leading `/`, no empty, `.` or `..` segment; a name ending
 *     in `/` is a directory entry without data; names equal under ASCII
 *     case folding are duplicates.
 *
 * LIMITS (the scanner's, not the reader machine's): the end record is
 * searched in the last 64 KiB + 22 bytes only; at most 5 000 entries and
 * 1 MiB of central directory; ZIP64 (any 0xFFFF/0xFFFFFFFF marker, a ZIP64
 * extra field, end record or locator), multi-disk archives, encrypted
 * entries (flag bits 0, 6 and 13) and Info-ZIP Unicode Path fields (an
 * alternative name) are refused. One entry at a time is read (readEntry),
 * at most 64 KiB compressed and 256 KiB inflated, checked against its
 * CRC-32. Every read goes through `RandomAccessFile`: the head, the tail
 * window, the directory, every local header and descriptor, and the one
 * entry. Never the whole file (the PDF polyglot scan, hasZipEndRecord,
 * reads a PDF from start to end in 64 KiB reads).
 *
 * Every refusal throws ZipRefusal; the caller turns any error into a
 * refusal of the upload (an unexpected exception is a refusal too).
 */
import { crc32, inflateRawSync } from "node:zlib";

/** Positional reads of one file (one file handle in production). */
export interface RandomAccessFile {
  readonly size: number;
  /** Up to `length` bytes at `position`; fewer only at the end of the file. */
  read(position: number, length: number): Promise<Uint8Array>;
}

/** The layout or a limit refused the file. `reason` is for logs and tests. */
export class ZipRefusal extends Error {
  constructor(readonly reason: string) {
    super(`zip refused: ${reason}`);
    this.name = "ZipRefusal";
  }
}

export const ZIP_LIMITS = {
  /** The end record lies in the last 64 KiB + 22 bytes (its comment is at most 0xFFFF). */
  endSearchBytes: 64 * 1024 + 22,
  maxEntries: 5000,
  maxDirectoryBytes: 1024 * 1024,
} as const;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const END_RECORD_BYTES = 22;
const CENTRAL_RECORD_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const ZIP64_EXTRA_ID = 0x0001;
/** Info-ZIP Unicode Path: an alternative name some readers prefer. */
const UNICODE_PATH_EXTRA_ID = 0x7075;
/** Bit 0 encrypted, bit 6 strong encryption, bit 13 masked local headers. */
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  /** The name as stored (printable ASCII). */
  name: string;
  /** Directory entries carry no data and are otherwise ignored. */
  isDirectory: boolean;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Where the entry's data starts (after the local header, name and extra field). */
  dataOffset: number;
}

export interface ZipLayout {
  /** Every entry, in local-header order. */
  entries: ZipEntry[];
  /** Entries by ASCII-lower-cased name. */
  byName: ReadonlyMap<string, ZipEntry>;
}

const u16 = (buf: Uint8Array, at: number): number => buf[at] | (buf[at + 1] << 8);
const u32 = (buf: Uint8Array, at: number): number =>
  (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;

/** Exactly `length` bytes at `position`, else the file is truncated. */
async function readExactly(
  file: RandomAccessFile,
  position: number,
  length: number,
): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array(0);
  if (position < 0 || position + length > file.size) throw new ZipRefusal("read past the end");
  const bytes = await file.read(position, length);
  if (bytes.length !== length) throw new ZipRefusal("short read");
  return bytes;
}

function hasSignature(bytes: Uint8Array, from: number, to: number, signature: number): boolean {
  for (let i = from; i + 4 <= to; i++) if (u32(bytes, i) === signature) return true;
  return false;
}

interface EndRecordCandidate {
  /** Absolute offset of the signature. */
  position: number;
  /** The record and its comment end exactly at the end of the file. */
  endsAtEof: boolean;
}

interface TailWindow {
  start: number;
  bytes: Uint8Array;
  candidates: EndRecordCandidate[];
}

/** Every end-record signature in the last 64 KiB + 22 bytes. */
async function readTail(file: RandomAccessFile): Promise<TailWindow> {
  const start = Math.max(0, file.size - ZIP_LIMITS.endSearchBytes);
  const bytes = await readExactly(file, start, file.size - start);
  const candidates: EndRecordCandidate[] = [];
  for (let i = bytes.length - END_RECORD_BYTES; i >= 0; i--) {
    if (u32(bytes, i) !== SIG_END) continue;
    const end = start + i + END_RECORD_BYTES + u16(bytes, i + 20);
    candidates.push({ position: start + i, endsAtEof: end === file.size });
  }
  return { start, bytes, candidates };
}

/** Bytes per read of the polyglot scan. */
const SCAN_CHUNK_BYTES = 64 * 1024;
const END_SIGNATURE = Uint8Array.of(0x50, 0x4b, 0x05, 0x06);

/**
 * Whether a zip archive hides anywhere in the file (the PDF polyglot
 * refusal, §E1, amendment row A6; Codex round 2). Some readers (JSZip
 * among them) search the whole file for the end record, so padding after
 * an appended zip must not hide it: the file is scanned from start to end
 * in 64 KiB reads (never held whole in memory; a PDF is capped at 20 MB).
 * An end-record signature counts when a ZIP64 locator stands right before
 * it, or when a central directory signature stands where a reader would
 * look for the directory: its size before the record (an archive with data
 * before it), or at the offset it names. Its entry count is not trusted
 * (JSZip reads the directory whatever the count says; Codex round 3). A
 * random signature in compressed PDF data does not meet that.
 */
export async function hasZipEndRecord(file: RandomAccessFile): Promise<boolean> {
  if (file.size < END_RECORD_BYTES) return false;
  for (let start = 0; start < file.size; start += SCAN_CHUNK_BYTES) {
    const length = Math.min(SCAN_CHUNK_BYTES + END_RECORD_BYTES - 1, file.size - start);
    const bytes = await readExactly(file, start, length);
    let at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf(END_SIGNATURE);
    while (at >= 0 && at < SCAN_CHUNK_BYTES) {
      if (at + END_RECORD_BYTES <= bytes.length) {
        const position = start + at;
        if (position >= 20) {
          const locator = await readExactly(file, position - 20, 4);
          if (u32(locator, 0) === SIG_ZIP64_LOCATOR) return true;
        }
        const directorySize = u32(bytes, at + 12);
        const directoryOffset = u32(bytes, at + 16);
        const starts = [position - directorySize, directoryOffset].filter(
          (start) => start >= 0 && start + CENTRAL_RECORD_BYTES <= position,
        );
        for (const start of starts) {
          const signature = await readExactly(file, start, 4);
          if (u32(signature, 0) === SIG_CENTRAL) return true;
        }
      }
      at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf(END_SIGNATURE, at + 1);
    }
  }
  return false;
}

/** The ASCII-case-folded name (OPC compares part names that way). */
export const foldName = (name: string): string => name.toLowerCase();

function checkName(bytes: Uint8Array): { name: string; isDirectory: boolean } {
  if (bytes.length === 0) throw new ZipRefusal("empty name");
  for (const byte of bytes) {
    // Printable ASCII without space; no backslash, no percent.
    if (byte < 0x21 || byte > 0x7e || byte === 0x5c || byte === 0x25) {
      throw new ZipRefusal("name outside the allowed characters");
    }
  }
  const name = String.fromCharCode(...bytes);
  if (name.startsWith("/")) throw new ZipRefusal("absolute name");
  const isDirectory = name.endsWith("/");
  const segments = (isDirectory ? name.slice(0, -1) : name).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ZipRefusal("empty, . or .. segment");
  }
  return { name, isDirectory };
}

/**
 * Walks an extra field; refuses a malformed one, any ZIP64 record, and an
 * Info-ZIP Unicode Path field (0x7075): readers that honour it see another
 * name than the one this reader checked (Codex round 2: a VBA part named
 * harmlessly in the raw name and `word/vbaProject.bin` in the field).
 */
function checkExtraField(extra: Uint8Array): void {
  let at = 0;
  while (at < extra.length) {
    if (at + 4 > extra.length) throw new ZipRefusal("malformed extra field");
    const id = u16(extra, at);
    const size = u16(extra, at + 2);
    if (at + 4 + size > extra.length) throw new ZipRefusal("malformed extra field");
    if (id === ZIP64_EXTRA_ID) throw new ZipRefusal("ZIP64 extra field");
    if (id === UNICODE_PATH_EXTRA_ID) throw new ZipRefusal("Unicode Path extra field");
    at += 4 + size;
  }
}

interface CentralRecord extends Omit<ZipEntry, "dataOffset"> {
  nameBytes: Uint8Array;
}

function parseCentralDirectory(directory: Uint8Array, count: number): CentralRecord[] {
  const records: CentralRecord[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_RECORD_BYTES > directory.length) throw new ZipRefusal("directory too short");
    if (u32(directory, at) !== SIG_CENTRAL) throw new ZipRefusal("directory record signature");
    const flags = u16(directory, at + 8);
    const method = u16(directory, at + 10);
    const crc = u32(directory, at + 16);
    const compressedSize = u32(directory, at + 20);
    const uncompressedSize = u32(directory, at + 24);
    const nameLength = u16(directory, at + 28);
    const extraLength = u16(directory, at + 30);
    const commentLength = u16(directory, at + 32);
    const diskStart = u16(directory, at + 34);
    const localHeaderOffset = u32(directory, at + 42);
    const end = at + CENTRAL_RECORD_BYTES + nameLength + extraLength + commentLength;
    if (end > directory.length) throw new ZipRefusal("directory record past the directory");
    if (flags & ENCRYPTION_FLAGS) throw new ZipRefusal("encrypted entry");
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipRefusal(`method ${method}`);
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart === 0xffff
    ) {
      throw new ZipRefusal("ZIP64 marker");
    }
    if (diskStart !== 0) throw new ZipRefusal("multi-disk archive");
    const nameStart = at + CENTRAL_RECORD_BYTES;
    const nameBytes = directory.slice(nameStart, nameStart + nameLength);
    const { name, isDirectory } = checkName(nameBytes);
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new ZipRefusal("directory entry with data");
    }
    checkExtraField(
      directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
    );
    records.push({
      name,
      nameBytes,
      isDirectory,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    at = end;
  }
  if (at !== directory.length) throw new ZipRefusal("directory size disagrees with its records");
  return records;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Checks one entry's local header and descriptor; returns its data offset. */
async function checkLocalEntry(
  file: RandomAccessFile,
  record: CentralRecord,
  nextStart: number,
): Promise<number> {
  const offset = record.localHeaderOffset;
  if (offset + LOCAL_HEADER_BYTES > nextStart) throw new ZipRefusal("overlapping entries");
  const header = await readExactly(file, offset, LOCAL_HEADER_BYTES);
  if (u32(header, 0) !== SIG_LOCAL) throw new ZipRefusal("local header signature");
  const flags = u16(header, 6);
  const method = u16(header, 8);
  const nameLength = u16(header, 26);
  const extraLength = u16(header, 28);
  if (flags !== record.flags || method !== record.method) {
    throw new ZipRefusal("local header disagrees with the directory");
  }
  const dataOffset = offset + LOCAL_HEADER_BYTES + nameLength + extraLength;
  if (dataOffset > nextStart) throw new ZipRefusal("overlapping entries");
  const nameAndExtra = await readExactly(
    file,
    offset + LOCAL_HEADER_BYTES,
    nameLength + extraLength,
  );
  if (!sameBytes(nameAndExtra.subarray(0, nameLength), record.nameBytes)) {
    throw new ZipRefusal("local name disagrees with the directory");
  }
  checkExtraField(nameAndExtra.subarray(nameLength));
  const usesDescriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0;
  if (
    !usesDescriptor &&
    (u32(header, 14) !== record.crc ||
      u32(header, 18) !== record.compressedSize ||
      u32(header, 22) !== record.uncompressedSize)
  ) {
    throw new ZipRefusal("local sizes disagree with the directory");
  }
  const dataEnd = dataOffset + record.compressedSize;
  const gap = nextStart - dataEnd;
  if (!usesDescriptor) {
    if (gap !== 0) throw new ZipRefusal(gap > 0 ? "gap between entries" : "overlapping entries");
    return dataOffset;
  }
  // A data descriptor: 16 bytes with its signature, 12 without; a ZIP64
  // descriptor (64-bit sizes) is longer and refused.
  if (gap !== 16 && gap !== 12) throw new ZipRefusal("data descriptor does not fit");
  const descriptor = await readExactly(file, dataEnd, gap);
  const at = gap === 16 ? 4 : 0;
  if (gap === 16 && u32(descriptor, 0) !== SIG_DESCRIPTOR) {
    throw new ZipRefusal("data descriptor signature");
  }
  if (
    u32(descriptor, at) !== record.crc ||
    u32(descriptor, at + 4) !== record.compressedSize ||
    u32(descriptor, at + 8) !== record.uncompressedSize
  ) {
    throw new ZipRefusal("data descriptor disagrees with the directory");
  }
  return dataOffset;
}

/**
 * Reads and checks the whole layout (the end record, the directory, every
 * local header and data descriptor). Throws ZipRefusal for anything
 * outside the one accepted layout or the limits.
 */
export async function readZipLayout(file: RandomAccessFile): Promise<ZipLayout> {
  if (file.size < END_RECORD_BYTES) throw new ZipRefusal("too short");
  const tail = await readTail(file);
  const atEof = tail.candidates.filter((candidate) => candidate.endsAtEof);
  if (atEof.length !== 1) throw new ZipRefusal(`${atEof.length} end records at the end`);
  const endPosition = atEof[0].position;
  const end = tail.bytes.subarray(endPosition - tail.start);
  if (hasSignature(end, END_RECORD_BYTES, end.length, SIG_END)) {
    throw new ZipRefusal("an end record inside the comment");
  }
  const disk = u16(end, 4);
  const directoryDisk = u16(end, 6);
  const entriesOnDisk = u16(end, 8);
  const entryCount = u16(end, 10);
  const directorySize = u32(end, 12);
  const directoryOffset = u32(end, 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipRefusal("ZIP64 end record");
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipRefusal("multi-disk archive");
  }
  if (endPosition >= 20) {
    const locator = await readExactly(file, endPosition - 20, 4);
    if (u32(locator, 0) === SIG_ZIP64_LOCATOR) throw new ZipRefusal("ZIP64 locator");
  }
  if (entryCount === 0) throw new ZipRefusal("no entries");
  if (entryCount > ZIP_LIMITS.maxEntries) throw new ZipRefusal("too many entries");
  if (directorySize > ZIP_LIMITS.maxDirectoryBytes) throw new ZipRefusal("directory too large");
  if (directoryOffset + directorySize !== endPosition) {
    throw new ZipRefusal("directory does not end at the end record");
  }
  const directory = await readExactly(file, directoryOffset, directorySize);
  const records = parseCentralDirectory(directory, entryCount);

  const names = new Set<string>();
  for (const record of records) {
    const key = foldName(record.name);
    if (names.has(key)) throw new ZipRefusal("duplicate name");
    names.add(key);
  }
  const ordered = [...records].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  if (ordered[0].localHeaderOffset !== 0) throw new ZipRefusal("prefix before the first entry");
  const entries: ZipEntry[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const { nameBytes, ...record } = ordered[i];
    const nextStart = i + 1 < ordered.length ? ordered[i + 1].localHeaderOffset : directoryOffset;
    const dataOffset = await checkLocalEntry(file, { ...record, nameBytes }, nextStart);
    entries.push({ ...record, dataOffset });
  }
  return { entries, byName: new Map(entries.map((entry) => [foldName(entry.name), entry])) };
}

/** Bounds of one entry read. */
export interface EntryLimits {
  maxCompressed: number;
  maxInflated: number;
}

/** One entry's bytes: bounded, inflated with a cap, CRC-32 checked. */
export async function readEntry(
  file: RandomAccessFile,
  entry: ZipEntry,
  limits: EntryLimits,
): Promise<Uint8Array> {
  if (entry.compressedSize > limits.maxCompressed) throw new ZipRefusal("entry too large");
  if (entry.uncompressedSize > limits.maxInflated) throw new ZipRefusal("entry inflates too far");
  const raw = await readExactly(file, entry.dataOffset, entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === METHOD_STORED) {
    data = raw;
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: limits.maxInflated });
    } catch {
      throw new ZipRefusal("entry does not inflate within the limit");
    }
  }
  if (data.length !== entry.uncompressedSize) throw new ZipRefusal("entry size disagrees");
  if (crc32(data) >>> 0 !== entry.crc) throw new ZipRefusal("entry CRC-32 disagrees");
  return data;
}
