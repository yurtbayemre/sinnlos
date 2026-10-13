import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildZip,
  buildZipWithOffsets,
  minimalDocx,
  minimalOfficeEntries,
  minimalPdf,
  ooxmlFixture,
  type ZipEntrySpec,
} from "../integration/upload.test.helper";
import {
  ZIP_LIMITS,
  ZipRefusal,
  hasZipEndRecord,
  readEntry,
  readZipLayout,
  type RandomAccessFile,
} from "./upload-zip";

/**
 * The bounded zip reader and the one accepted layout (decision 06 §E1,
 * amendment row A6; batch 16 lane 16A, spike 11). Every refusal is a
 * ZipRefusal; nothing else may escape.
 */

interface SpyFile extends RandomAccessFile {
  reads: Array<{ position: number; length: number }>;
  bytesRead(): number;
}

function fileOf(bytes: Uint8Array): SpyFile {
  const reads: Array<{ position: number; length: number }> = [];
  return {
    size: bytes.length,
    reads,
    bytesRead: () => reads.reduce((sum, read) => sum + read.length, 0),
    async read(position, length) {
      const slice = bytes.subarray(position, position + length);
      reads.push({ position, length: slice.length });
      return slice;
    },
  };
}

async function refusal(bytes: Uint8Array): Promise<string> {
  try {
    await readZipLayout(fileOf(bytes));
  } catch (error) {
    if (error instanceof ZipRefusal) return error.reason;
    throw error;
  }
  return "accepted";
}

const patched = (bytes: Buffer, at: number, write: (buf: Buffer) => void): Buffer => {
  const copy = Buffer.from(bytes);
  write(copy.subarray(at));
  return copy;
};

const docxEntries = (entry?: Partial<Omit<ZipEntrySpec, "name" | "data">>) =>
  minimalOfficeEntries("docx", entry ? { entry } : {});

describe("the one accepted zip layout (amendment row A6)", () => {
  it("accepts a minimal package, stored and deflated", async () => {
    expect(await refusal(minimalDocx())).toBe("accepted");
    expect(await refusal(minimalDocx({ entry: { method: 0 } }))).toBe("accepted");
  });

  it("accepts agreeing data descriptors, with and without the signature", async () => {
    expect(await refusal(buildZip(docxEntries({ descriptor: "signature" })))).toBe("accepted");
    expect(await refusal(buildZip(docxEntries({ descriptor: "bare" })))).toBe("accepted");
  });

  it("accepts an end-record comment without a second signature, and directory entries", async () => {
    expect(await refusal(buildZip(docxEntries(), { comment: Buffer.from("made by x") }))).toBe(
      "accepted",
    );
    const entries = [...docxEntries(), { name: "word/media/", data: "", method: 0 }];
    expect(await refusal(buildZip(entries))).toBe("accepted");
  });

  it("refuses a prefix before the first entry", async () => {
    expect(await refusal(buildZip(docxEntries(), { prefix: Buffer.from("MZ junk") }))).toMatch(
      /prefix|directory does not end/,
    );
  });

  it("refuses trailing data after the end record", async () => {
    expect(await refusal(buildZip(docxEntries(), { trailing: Buffer.from("x") }))).toBe(
      "0 end records at the end",
    );
  });

  it("refuses a second end record inside the comment", async () => {
    const inner = buildZip([{ name: "a.txt", data: "a" }]);
    const comment = inner.subarray(inner.length - 22);
    expect(await refusal(buildZip(docxEntries(), { comment }))).toMatch(/end record/);
  });

  it("refuses overlapping entries and gaps between entries", async () => {
    const { bytes, offsets } = buildZipWithOffsets(docxEntries());
    // The third record points at the second entry's local header.
    const overlapping = patched(bytes, offsets.central[2] + 42, (b) =>
      b.writeUInt32LE(offsets.local[1], 0),
    );
    expect(await refusal(overlapping)).toMatch(/overlapping|disagrees|duplicate/);
    const entries = docxEntries();
    entries[0] = { ...entries[0], gapAfter: Buffer.from("gap") };
    expect(await refusal(buildZip(entries))).toBe("gap between entries");
  });

  it("refuses a local/central name mismatch, on [Content_Types].xml and on any entry", async () => {
    const entries = docxEntries();
    entries[0] = { ...entries[0], localName: "[Content_Types].xmL" };
    expect(await refusal(buildZip(entries))).toBe("local name disagrees with the directory");
    const other = docxEntries();
    other[2] = { ...other[2], localName: "word/documenT.xml" };
    expect(await refusal(buildZip(other))).toBe("local name disagrees with the directory");
  });

  it("refuses local sizes or a data descriptor that disagree with the directory", async () => {
    const { bytes, offsets } = buildZipWithOffsets(docxEntries());
    expect(await refusal(patched(bytes, offsets.local[1] + 14, (b) => b.writeUInt32LE(1, 0)))).toBe(
      "local sizes disagree with the directory",
    );
    const withDescriptor = buildZipWithOffsets(docxEntries({ descriptor: "signature" }));
    // The first descriptor ends where the second entry begins; its CRC is 12 bytes before that.
    const crcAt = withDescriptor.offsets.local[1] - 12;
    expect(
      await refusal(patched(withDescriptor.bytes, crcAt, (b) => b.writeUInt32LE(0xdeadbeef, 0))),
    ).toBe("data descriptor disagrees with the directory");
  });

  it("refuses any method but stored and deflate", async () => {
    const entries = docxEntries();
    entries[1] = { ...entries[1], method: 12 };
    expect(await refusal(buildZip(entries))).toBe("method 12");
  });

  it.each([
    ["a percent sign", "word/a%2e.xml"],
    ["a backslash", "word\\a.xml"],
    ["a non-ASCII byte", "word/é.xml"],
    ["a space", "word/a b.xml"],
    ["a leading slash", "/word/a.xml"],
    ["an empty segment", "word//a.xml"],
    ["a . segment", "word/./a.xml"],
    ["a .. segment", "word/../a.xml"],
  ])("refuses a name with %s", async (_label, name) => {
    const entries = [...docxEntries(), { name, data: "x" }];
    expect(await refusal(buildZip(entries))).toMatch(/name|segment/);
  });

  it("refuses names equal under ASCII case folding", async () => {
    const entries = [...docxEntries(), { name: "WORD/document.xml", data: "x" }];
    expect(await refusal(buildZip(entries))).toBe("duplicate name");
  });

  it("refuses a directory entry with data", async () => {
    const entries = [...docxEntries(), { name: "word/media/", data: "x", method: 0 }];
    expect(await refusal(buildZip(entries))).toBe("directory entry with data");
  });

  it("refuses encrypted entries (flag bits 0, 6, 13)", async () => {
    for (const flag of [0x0001, 0x0040, 0x2000]) {
      const entries = docxEntries();
      entries[1] = { ...entries[1], flags: flag };
      expect(await refusal(buildZip(entries)), String(flag)).toBe("encrypted entry");
    }
  });

  it("refuses every ZIP64 marker", async () => {
    const { bytes, offsets } = buildZipWithOffsets(docxEntries());
    expect(await refusal(patched(bytes, offsets.end + 10, (b) => b.writeUInt16LE(0xffff, 0)))).toBe(
      "ZIP64 end record",
    );
    expect(
      await refusal(patched(bytes, offsets.central[1] + 20, (b) => b.writeUInt32LE(0xffffffff, 0))),
    ).toBe("ZIP64 marker");
    const zip64Extra = Buffer.alloc(20);
    zip64Extra.writeUInt16LE(0x0001, 0);
    zip64Extra.writeUInt16LE(16, 2);
    const entries = docxEntries();
    entries[1] = { ...entries[1], extra: zip64Extra };
    expect(await refusal(buildZip(entries))).toBe("ZIP64 extra field");
    // A ZIP64 end-record locator right before the end record.
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const withLocator = Buffer.concat([
      bytes.subarray(0, offsets.end),
      locator,
      bytes.subarray(offsets.end),
    ]);
    expect(await refusal(withLocator)).toBe("ZIP64 locator");
  });

  it("refuses multi-disk archives", async () => {
    const { bytes, offsets } = buildZipWithOffsets(docxEntries());
    expect(await refusal(patched(bytes, offsets.end + 4, (b) => b.writeUInt16LE(1, 0)))).toBe(
      "multi-disk archive",
    );
    expect(
      await refusal(patched(bytes, offsets.central[0] + 34, (b) => b.writeUInt16LE(1, 0))),
    ).toBe("multi-disk archive");
  });

  it("refuses more than 5 000 entries and a directory over 1 MiB", async () => {
    const many = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({
      name: `x/${i}`,
      data: "",
      method: 0,
    }));
    expect(await refusal(buildZip(many))).toBe("too many entries");
    const extra = Buffer.alloc(60_000);
    extra.writeUInt16LE(0xcafe, 0);
    extra.writeUInt16LE(60_000 - 4, 2);
    const fat = Array.from({ length: 18 }, (_, i) => ({
      name: `x/${i}`,
      data: "",
      method: 0,
      extra,
    }));
    expect(await refusal(buildZip(fat))).toBe("directory too large");
  });

  it("refuses files that are no zip at all", async () => {
    expect(await refusal(Buffer.from("PK\u0003\u0004 not really"))).toMatch(
      /end records|too short/,
    );
    expect(await refusal(new Uint8Array(0))).toBe("too short");
  });
});

describe("readEntry: one bounded entry", () => {
  it("inflates within the cap and checks the CRC-32", async () => {
    const bytes = minimalDocx();
    const file = fileOf(bytes);
    const layout = await readZipLayout(file);
    const entry = layout.byName.get("[content_types].xml");
    expect(entry).toBeDefined();
    const data = await readEntry(file, entry!, {
      maxCompressed: 64 * 1024,
      maxInflated: 256 * 1024,
    });
    expect(Buffer.from(data).toString("utf8")).toContain("<Types");
    await expect(
      readEntry(
        file,
        { ...entry!, crc: entry!.crc ^ 1 },
        { maxCompressed: 1 << 16, maxInflated: 1 << 18 },
      ),
    ).rejects.toThrow(ZipRefusal);
    await expect(
      readEntry(file, entry!, { maxCompressed: 10, maxInflated: 1 << 18 }),
    ).rejects.toThrow("entry too large");
  });

  it("stops a zip bomb at the inflation cap, whatever the directory claims", async () => {
    const bomb = buildZip([{ name: "a", data: Buffer.alloc(10 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(20_000);
    const file = fileOf(bomb);
    const layout = await readZipLayout(file);
    const entry = layout.entries[0];
    await expect(
      readEntry(file, entry, { maxCompressed: 64 * 1024, maxInflated: 256 * 1024 }),
    ).rejects.toThrow("entry inflates too far");
    // A directory that lies about the size: the inflation cap still holds.
    await expect(
      readEntry(
        file,
        { ...entry, uncompressedSize: 100 },
        { maxCompressed: 1 << 16, maxInflated: 1 << 18 },
      ),
    ).rejects.toThrow("entry does not inflate within the limit");
  });
});

describe("hasZipEndRecord (the PDF polyglot refusal)", () => {
  it("finds an appended zip, also behind trailing bytes", async () => {
    const pdf = minimalPdf();
    expect(await hasZipEndRecord(fileOf(pdf))).toBe(false);
    const polyglot = Buffer.concat([pdf, minimalDocx()]);
    expect(await hasZipEndRecord(fileOf(polyglot))).toBe(true);
    expect(await hasZipEndRecord(fileOf(Buffer.concat([polyglot, Buffer.from("%%EOF\n")])))).toBe(
      true,
    );
  });

  it("ignores an end-record signature whose comment would run past the end", async () => {
    const signature = Buffer.alloc(22);
    signature.writeUInt32LE(0x06054b50, 0);
    signature.writeUInt16LE(500, 20);
    expect(await hasZipEndRecord(fileOf(Buffer.concat([minimalPdf(), signature])))).toBe(false);
  });
});

describe("reading is bounded (an I/O spy)", () => {
  it("reads the tail window, the directory, the headers and the one entry, never the whole file", async () => {
    const big = randomBytes(2 * 1024 * 1024);
    const entries = [
      ...minimalOfficeEntries("docx"),
      { name: "word/media/big.bin", data: big, method: 0 },
    ];
    const { bytes, offsets } = buildZipWithOffsets(entries);
    const file = fileOf(bytes);
    const layout = await readZipLayout(file);
    await readEntry(file, layout.byName.get("[content_types].xml")!, {
      maxCompressed: 64 * 1024,
      maxInflated: 256 * 1024,
    });
    expect(file.bytesRead()).toBeLessThan(ZIP_LIMITS.endSearchBytes + 4 * 1024);
    const bigData = {
      start: offsets.local[3] + 30 + "word/media/big.bin".length,
      end: offsets.central[0],
    };
    // Only the tail window may touch the big entry's data (its last 64 KiB).
    for (const read of file.reads) {
      const inData = read.position < bigData.end && read.position + read.length > bigData.start;
      if (inData) expect(read.position + read.length).toBe(bytes.length);
    }
  });
});

describe("robustness: truncated and bit-flipped real files refuse, never throw", () => {
  const fixtures = ["word-desktop.docx", "excel-desktop.xlsx", "python-zipfile-streamed.xlsx"];

  it.each(fixtures)("%s truncated at every directory offset", async (name) => {
    const bytes = ooxmlFixture(name);
    expect(await refusal(bytes)).toBe("accepted");
    // The fixtures carry no end-record comment: the directory offset is at -6.
    const directoryStart = bytes.readUInt32LE(bytes.length - 6);
    for (let size = directoryStart; size < bytes.length; size++) {
      const reason = await refusal(bytes.subarray(0, size));
      expect(reason, `size ${size}`).not.toBe("accepted");
    }
  });

  it.each(fixtures)("%s with a byte flipped in any header", async (name) => {
    const bytes = ooxmlFixture(name);
    const layout = await readZipLayout(fileOf(bytes));
    const headerBytes = new Set<number>();
    for (const entry of layout.entries) {
      for (let i = entry.localHeaderOffset; i < entry.dataOffset; i++) headerBytes.add(i);
    }
    for (let i = bytes.readUInt32LE(bytes.length - 6); i < bytes.length; i++) headerBytes.add(i);
    for (const at of headerBytes) {
      const copy = Buffer.from(bytes);
      copy[at] ^= 0xff;
      // A refusal or the same layout; never an exception other than ZipRefusal.
      const reason = await refusal(copy);
      if (reason === "accepted") {
        const again = await readZipLayout(fileOf(copy));
        expect(again.entries.map((e) => e.name.toLowerCase())).toEqual(
          layout.entries.map((e) => e.name.toLowerCase()),
        );
      }
    }
  });
});
