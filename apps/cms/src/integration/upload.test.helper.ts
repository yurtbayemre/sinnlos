/**
 * Uploads for the test suites (batch 16 plan, contract K13; ported from the
 * v2 spike's spike-v2.test.helper.ts and extended for spike 11):
 *
 *   - `buildZip(entries, options)`: a zip writer for real and broken
 *     layouts (stored and deflate through node:zlib, data descriptors with
 *     and without signature, a prefix, gaps, trailing bytes, a comment);
 *     `zipOffsets` tells where each header lies, so a case can patch bytes;
 *   - `contentTypesXml`, `minimalDocx`, `minimalXlsx`, `minimalPptx`,
 *     `minimalPdf`, `PNG_1PX` (`pngOfSize` pads it): the smallest files
 *     each rule accepts;
 *   - `memoryFile(bytes, size)`: bytes as the RandomAccessFile the rules
 *     read through;
 *   - `OOXML_FIXTURES_DIR` and `ooxmlFixture(name)`: the real producer
 *     files of spike 11 (apps/cms/src/test/fixtures/ooxml, README there);
 *   - `uploadFiles(t, jwt, files, fields)`: POST /api/upload as the web
 *     sends it (multipart `files`, optional `fileInfo` and other fields).
 *
 * Named *.test.helper.ts: not a suite, not part of the cms build. Unit
 * suites import it too; it imports only types from the harness and the
 * zip reader.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import type { RandomAccessFile } from "../utils/upload-zip";
import type { TestStrapi } from "./harness.test.helper";

/** The spike-11 fixtures (real producer files; README.md names each producer). */
export const OOXML_FIXTURES_DIR = join(__dirname, "..", "test", "fixtures", "ooxml");

export function ooxmlFixture(name: string): Buffer {
  return readFileSync(join(OOXML_FIXTURES_DIR, name));
}

// ---------------------------------------------------------------------------
// The zip writer.

export interface ZipEntrySpec {
  name: string;
  data: string | Uint8Array;
  /** 0 stored, 8 deflate (default), anything else is written as given (with stored bytes). */
  method?: number;
  /** A data descriptor after the data: with the PK\x07\x08 signature, or bare. */
  descriptor?: "signature" | "bare";
  /** Extra general-purpose flags (bit 3 is set by `descriptor`). */
  flags?: number;
  /** The local header's name, when it must differ from the directory's. */
  localName?: string;
  /** Bytes between this entry and the next (a gap). */
  gapAfter?: Uint8Array;
  /** Raw extra field bytes, local and central. */
  extra?: Uint8Array;
}

export interface ZipOptions {
  /** Bytes before the first local header. */
  prefix?: Uint8Array;
  /** The end record's comment. */
  comment?: Uint8Array;
  /** Bytes after the end record (and its comment). */
  trailing?: Uint8Array;
  /** Write the directory records in this order of entry indexes (default: entry order). */
  directoryOrder?: number[];
}

export interface ZipOffsets {
  /** Local header offset of each entry (in entry order). */
  local: number[];
  /** Directory record offset of each entry (in entry order). */
  central: number[];
  /** The end record's offset. */
  end: number;
}

const bytesOf = (data: string | Uint8Array): Buffer =>
  typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);

/** Builds a zip; `zipOffsets` of the result tells where its headers lie. */
export function buildZipWithOffsets(
  entries: ZipEntrySpec[],
  options: ZipOptions = {},
): { bytes: Buffer; offsets: ZipOffsets } {
  const parts: Buffer[] = [];
  let offset = 0;
  const push = (buf: Buffer) => {
    parts.push(buf);
    offset += buf.length;
  };
  if (options.prefix) push(Buffer.from(options.prefix));
  const records: Array<{
    name: Buffer;
    method: number;
    flags: number;
    crc: number;
    compressed: number;
    size: number;
    localOffset: number;
    extra: Buffer;
  }> = [];
  const local: number[] = [];
  for (const entry of entries) {
    const data = bytesOf(entry.data);
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data) >>> 0;
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 0x0008 : 0);
    const name = Buffer.from(entry.name, "latin1");
    const localName = Buffer.from(entry.localName ?? entry.name, "latin1");
    const extra = Buffer.from(entry.extra ?? new Uint8Array(0));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(stored.length, 18);
      header.writeUInt32LE(data.length, 22);
    }
    header.writeUInt16LE(localName.length, 26);
    header.writeUInt16LE(extra.length, 28);
    local.push(offset);
    records.push({
      name,
      method,
      flags,
      crc,
      compressed: stored.length,
      size: data.length,
      localOffset: offset,
      extra,
    });
    push(header);
    push(localName);
    push(extra);
    push(stored);
    if (entry.descriptor) {
      const descriptor = Buffer.alloc(entry.descriptor === "signature" ? 16 : 12);
      let at = 0;
      if (entry.descriptor === "signature") {
        descriptor.writeUInt32LE(0x08074b50, 0);
        at = 4;
      }
      descriptor.writeUInt32LE(crc, at);
      descriptor.writeUInt32LE(stored.length, at + 4);
      descriptor.writeUInt32LE(data.length, at + 8);
      push(descriptor);
    }
    if (entry.gapAfter) push(Buffer.from(entry.gapAfter));
  }
  const directoryOffset = offset;
  const central: number[] = new Array<number>(entries.length);
  for (const index of options.directoryOrder ?? entries.map((_, i) => i)) {
    const record = records[index];
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(record.flags, 8);
    header.writeUInt16LE(record.method, 10);
    header.writeUInt32LE(record.crc, 16);
    header.writeUInt32LE(record.compressed, 20);
    header.writeUInt32LE(record.size, 24);
    header.writeUInt16LE(record.name.length, 28);
    header.writeUInt16LE(record.extra.length, 30);
    header.writeUInt32LE(record.localOffset, 42);
    central[index] = offset;
    push(header);
    push(record.name);
    push(record.extra);
  }
  const directorySize = offset - directoryOffset;
  const comment = Buffer.from(options.comment ?? new Uint8Array(0));
  const count = (options.directoryOrder ?? entries).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  const endOffset = offset;
  push(end);
  push(comment);
  if (options.trailing) push(Buffer.from(options.trailing));
  return { bytes: Buffer.concat(parts), offsets: { local, central, end: endOffset } };
}

export function buildZip(entries: ZipEntrySpec[], options: ZipOptions = {}): Buffer {
  return buildZipWithOffsets(entries, options).bytes;
}

// ---------------------------------------------------------------------------
// Minimal files.

export const CT_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";

export const MAIN_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
} as const;

export const MAIN_PARTS = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
} as const;

export type MinimalOffice = keyof typeof MAIN_TYPES;

/** A `[Content_Types].xml` with the usual two Defaults plus the given elements. */
export function contentTypesXml(
  overrides: Array<{ partName: string; contentType: string }>,
  extraDefaults: Array<{ extension: string; contentType: string }> = [],
): string {
  const defaults = [
    { extension: "rels", contentType: "application/vnd.openxmlformats-package.relationships+xml" },
    { extension: "xml", contentType: "application/xml" },
    ...extraDefaults,
  ];
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<Types xmlns="${CT_NAMESPACE}">` +
    defaults
      .map((d) => `<Default Extension="${d.extension}" ContentType="${d.contentType}"/>`)
      .join("") +
    overrides
      .map((o) => `<Override PartName="${o.partName}" ContentType="${o.contentType}"/>`)
      .join("") +
    "</Types>"
  );
}

const RELS = (target: string) =>
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

const MAIN_BODY: Record<MinimalOffice, string> = {
  docx: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>sinnlos</w:t></w:r></w:p></w:body></w:document>',
  xlsx: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
  pptx: '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
};

export interface MinimalOfficeOptions {
  /** Replaces the generated `[Content_Types].xml`. */
  contentTypes?: string;
  /** More entries, after the standard ones. */
  extra?: ZipEntrySpec[];
  /** The main part's name (default the conventional one). */
  mainPart?: string;
  /** Per-entry options for the standard entries (method, descriptor). */
  entry?: Partial<Omit<ZipEntrySpec, "name" | "data">>;
  zip?: ZipOptions;
}

/** The standard entries of a minimal package (before `buildZip`). */
export function minimalOfficeEntries(
  format: MinimalOffice,
  options: MinimalOfficeOptions = {},
): ZipEntrySpec[] {
  const mainPart = options.mainPart ?? MAIN_PARTS[format];
  const contentTypes =
    options.contentTypes ??
    contentTypesXml([{ partName: `/${mainPart}`, contentType: MAIN_TYPES[format] }]);
  return [
    { name: "[Content_Types].xml", data: contentTypes, ...options.entry },
    { name: "_rels/.rels", data: RELS(mainPart), ...options.entry },
    { name: mainPart, data: MAIN_BODY[format], ...options.entry },
    ...(options.extra ?? []),
  ];
}

export function minimalOffice(format: MinimalOffice, options: MinimalOfficeOptions = {}): Buffer {
  return buildZip(minimalOfficeEntries(format, options), options.zip);
}

export const minimalDocx = (options?: MinimalOfficeOptions) => minimalOffice("docx", options);
export const minimalXlsx = (options?: MinimalOfficeOptions) => minimalOffice("xlsx", options);
export const minimalPptx = (options?: MinimalOfficeOptions) => minimalOffice("pptx", options);

/** A minimal PDF, padded with spaces to `padTo` bytes. */
export function minimalPdf(padTo = 0): Buffer {
  const head = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1",
  );
  return padTo > head.length
    ? Buffer.concat([head, Buffer.alloc(padTo - head.length, 0x20)])
    : head;
}

/** A 1x1 PNG. */
export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A file padded to `size` bytes after a valid PNG (the image sniff reads the head only). */
export function pngOfSize(size: number): Buffer {
  return Buffer.concat([PNG_1PX, Buffer.alloc(Math.max(0, size - PNG_1PX.length))]);
}

/** `bytes` as a RandomAccessFile; a larger `size` reads short past the bytes. */
export function memoryFile(bytes: Uint8Array, size = bytes.length): RandomAccessFile {
  return { size, read: async (position, length) => bytes.subarray(position, position + length) };
}

// ---------------------------------------------------------------------------
// The upload request.

export interface UploadFile {
  name: string;
  /** The declared Content-Type (ignored by the wrapper; default application/octet-stream). */
  type?: string;
  bytes: Uint8Array;
}

export interface UploadResponse {
  status: number;
  body: any;
}

/** POST /api/upload as the web does it: multipart `files`, plus optional fields. */
export async function uploadFiles(
  t: TestStrapi,
  jwt: string,
  files: UploadFile[],
  fields: Record<string, string> = {},
  query = "",
): Promise<UploadResponse> {
  const form = new FormData();
  for (const file of files) {
    form.append(
      "files",
      new Blob([new Uint8Array(file.bytes)], { type: file.type ?? "application/octet-stream" }),
      file.name,
    );
  }
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${t.baseUrl}/api/upload${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: form,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: res.status, body };
}
