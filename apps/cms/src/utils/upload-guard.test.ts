import { describe, expect, it } from "vitest";

import {
  CANONICAL_EXTENSION,
  MAX_FILE_BYTES,
  SNIFF_BYTES,
  canonicalFilename,
  createdFileIds,
  declaredSize,
  exceedsSizeLimit,
  isAllowedUploadBody,
  sniffImageMime,
  toFileArray,
} from "./upload-guard";

/** First bytes of real files, padded to the sniff window. */
const pad = (bytes: number[]) => Uint8Array.from([...bytes, ...new Array(16).fill(0)]);
const text = (s: string) => pad([...s].map((c) => c.charCodeAt(0)));

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Uint8Array.from([
  ...[..."RIFF"].map((c) => c.charCodeAt(0)),
  0x24,
  0x00,
  0x00,
  0x00,
  ...[..."WEBP"].map((c) => c.charCodeAt(0)),
]);

describe("sniffImageMime", () => {
  it("recognises JPEG, PNG and WebP by magic bytes", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("rejects everything else (GIF, SVG, PDF, ZIP, RIFF-but-not-WebP)", () => {
    expect(sniffImageMime(text("GIF89a"))).toBeNull();
    expect(sniffImageMime(text("<svg xmlns="))).toBeNull();
    expect(sniffImageMime(text("%PDF-1.7"))).toBeNull();
    expect(sniffImageMime(pad([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(sniffImageMime(text("RIFF\u0024\u0000\u0000\u0000WAVE"))).toBeNull();
  });

  it("rejects a head shorter than the sniff window", () => {
    expect(sniffImageMime(JPEG.subarray(0, SNIFF_BYTES - 1))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });
});

describe("canonicalFilename", () => {
  it("replaces the client extension with the sniffed type's canonical one", () => {
    expect(canonicalFilename("invoice.pdf", "image/jpeg")).toBe("invoice.jpg");
    expect(canonicalFilename("style.css", "image/png")).toBe("style.png");
    expect(canonicalFilename("photo.JPEG", "image/jpeg")).toBe("photo.jpg");
    expect(canonicalFilename("holiday.2026.png", "image/webp")).toBe("holiday.2026.webp");
    expect(canonicalFilename("noext", "image/png")).toBe("noext.png");
  });

  it("drops directory parts for both separators", () => {
    expect(canonicalFilename("../../etc/passwd", "image/jpeg")).toBe("passwd.jpg");
    expect(canonicalFilename("C:\\Users\\me\\cat.gif", "image/png")).toBe("cat.png");
  });

  it("falls back to 'image' for an empty stem", () => {
    expect(canonicalFilename(".jpg", "image/jpeg")).toBe("image.jpg");
    expect(canonicalFilename("", "image/webp")).toBe("image.webp");
    expect(canonicalFilename("dir/", "image/png")).toBe("image.png");
    expect(canonicalFilename("  .pdf", "image/png")).toBe("image.png");
  });

  it("always ends in exactly the canonical extension", () => {
    for (const [mime, ext] of Object.entries(CANONICAL_EXTENSION)) {
      const name = canonicalFilename("a.b.c.html", mime as keyof typeof CANONICAL_EXTENSION);
      expect(name.endsWith(ext)).toBe(true);
      expect(name).toBe(`a.b.c${ext}`);
    }
  });
});

describe("isAllowedUploadBody", () => {
  it("accepts an absent/empty body and fileInfo alone", () => {
    expect(isAllowedUploadBody(undefined)).toBe(true);
    expect(isAllowedUploadBody(null)).toBe(true);
    expect(isAllowedUploadBody({})).toBe(true);
    expect(isAllowedUploadBody({ fileInfo: '{"alternativeText":"a"}' })).toBe(true);
  });

  it.each(["ref", "refId", "field", "path", "folder", "__proto__x"])("rejects %s", (key) => {
    expect(isAllowedUploadBody({ [key]: "x" })).toBe(false);
    expect(isAllowedUploadBody({ fileInfo: "{}", [key]: "x" })).toBe(false);
  });

  it("rejects non-object bodies", () => {
    expect(isAllowedUploadBody("ref=api::classified.classified")).toBe(false);
    expect(isAllowedUploadBody(["fileInfo"])).toBe(false);
    expect(isAllowedUploadBody(42)).toBe(false);
  });
});

describe("size helpers", () => {
  it("only trusts a finite numeric declared size", () => {
    expect(declaredSize(10)).toBe(10);
    expect(declaredSize(0)).toBe(0);
    expect(declaredSize(undefined)).toBeNull();
    expect(declaredSize("10")).toBeNull();
    expect(declaredSize(NaN)).toBeNull();
    expect(declaredSize(Infinity)).toBeNull();
  });

  it("allows exactly 5 MB and rejects one byte more", () => {
    expect(exceedsSizeLimit(MAX_FILE_BYTES)).toBe(false);
    expect(exceedsSizeLimit(MAX_FILE_BYTES + 1)).toBe(true);
  });
});

describe("toFileArray / createdFileIds", () => {
  it("normalises formidable's single-or-array shape", () => {
    expect(toFileArray(undefined)).toEqual([]);
    expect(toFileArray(null)).toEqual([]);
    expect(toFileArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(toFileArray([{ a: 1 }, { a: 2 }])).toHaveLength(2);
  });

  it("extracts numeric ids from the core response body only", () => {
    expect(createdFileIds([{ id: 1 }, { id: "2" }, null, { id: 3 }])).toEqual([1, 3]);
    expect(createdFileIds({ id: 7 })).toEqual([7]);
    expect(createdFileIds(undefined)).toEqual([]);
  });
});
