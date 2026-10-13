import { DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES, type UploadFormat } from "@sinnlos/domain";
import { describe, expect, it } from "vitest";

import {
  PNG_1PX,
  minimalDocx,
  minimalPdf,
  minimalPptx,
  minimalXlsx,
  ooxmlFixture,
} from "../integration/upload.test.helper";
import {
  CANONICAL_EXTENSION,
  SNIFF_BYTES,
  canonicalFilename,
  createdFileIds,
  declaredSize,
  isAllowedUploadBody,
  normalizeFileInfo,
  profileMaxBytes,
  refusedBodyKeys,
  sniffImageMime,
  sniffUpload,
  toFileArray,
  uploadHashSlug,
  uploadProfileOf,
  type UploadProfile,
} from "./upload-guard";
import type { RandomAccessFile } from "./upload-zip";

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
    expect(canonicalFilename("invoice.pdf", "jpeg")).toBe("invoice.jpg");
    expect(canonicalFilename("style.css", "png")).toBe("style.png");
    expect(canonicalFilename("photo.JPEG", "jpeg")).toBe("photo.jpg");
    expect(canonicalFilename("holiday.2026.png", "webp")).toBe("holiday.2026.webp");
    expect(canonicalFilename("noext", "png")).toBe("noext.png");
  });

  it("drops directory parts for both separators", () => {
    expect(canonicalFilename("../../etc/passwd", "jpeg")).toBe("passwd.jpg");
    expect(canonicalFilename("C:\\Users\\me\\cat.gif", "png")).toBe("cat.png");
  });

  it("falls back to 'image' for an empty stem", () => {
    expect(canonicalFilename(".jpg", "jpeg")).toBe("image.jpg");
    expect(canonicalFilename("", "webp")).toBe("image.webp");
    expect(canonicalFilename("dir/", "png")).toBe("image.png");
    expect(canonicalFilename("  .pdf", "png")).toBe("image.png");
  });

  it("falls back to 'image' for a stem core slugs to nothing (C2-UPLOAD-EMPTY-SLUG)", () => {
    for (const name of ["写真.png", "截图.jpg", "🙂.webp", "€.png", "—.png", "---.png", "_.png"]) {
      expect(canonicalFilename(name, "png"), name).toBe("image.png");
    }
    // Anything core can slug keeps the client's stem (core transliterates it).
    expect(canonicalFilename("Ärger.jpg", "jpeg")).toBe("Ärger.jpg");
    expect(canonicalFilename("é.jpg", "jpeg")).toBe("é.jpg");
    expect(canonicalFilename("写真 2.png", "png")).toBe("写真 2.png");
  });

  it("never hands core a stem whose stored hash would start with `_`", () => {
    for (const name of ["写真.png", "a.png", "🙂.png", ".png", "Ärger.png", "-_-.png", "x🙂.png"]) {
      const stored = canonicalFilename(name, "png");
      const slug = uploadHashSlug(stored.slice(0, stored.lastIndexOf(".")));
      expect(slug, name).toMatch(/^[A-Za-z0-9]/);
    }
  });

  it("always ends in exactly the canonical extension", () => {
    const formats: Record<string, UploadFormat> = {
      "image/jpeg": "jpeg",
      "image/png": "png",
      "image/webp": "webp",
    };
    for (const [mime, ext] of Object.entries(CANONICAL_EXTENSION)) {
      const name = canonicalFilename("a.b.c.html", formats[mime]);
      expect(name.endsWith(ext)).toBe(true);
      expect(name).toBe(`a.b.c${ext}`);
    }
    for (const [format, ext] of [
      ["pdf", ".pdf"],
      ["docx", ".docx"],
      ["xlsx", ".xlsx"],
      ["pptx", ".pptx"],
    ] as const) {
      expect(canonicalFilename("report.xlsm", format)).toBe(`report${ext}`);
      expect(canonicalFilename("写真.docm", format)).toBe(`document${ext}`);
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
    expect(declaredSize(-1)).toBeNull();
  });

  it("caps a profile before any read: 20 MB for the document profile, 5 MB for images", () => {
    expect(profileMaxBytes("document")).toBe(DOCUMENT_MAX_BYTES);
    expect(profileMaxBytes("image")).toBe(IMAGE_MAX_BYTES);
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

describe("refusedBodyKeys", () => {
  it("names every key but fileInfo, sorted; a non-object body is `body`", () => {
    expect(refusedBodyKeys(undefined)).toEqual([]);
    expect(refusedBodyKeys({ fileInfo: "{}" })).toEqual([]);
    expect(refusedBodyKeys({ refId: "1", ref: "x", fileInfo: "{}" })).toEqual(["ref", "refId"]);
    expect(refusedBodyKeys("x")).toEqual(["body"]);
  });
});

describe("normalizeFileInfo (the stored name stays canonical)", () => {
  it("drops `name` and keeps the other keys core accepts", () => {
    expect(
      normalizeFileInfo('{"name":"evil.html","alternativeText":"a","caption":null}', 1),
    ).toEqual({ malformed: false, value: { alternativeText: "a", caption: null } });
    expect(normalizeFileInfo({ focalPoint: { x: 1, y: 99 } }, 1)).toEqual({
      malformed: false,
      value: { focalPoint: { x: 1, y: 99 } },
    });
    expect(normalizeFileInfo(undefined, 1)).toEqual({ malformed: false, value: undefined });
    expect(normalizeFileInfo(["{}", '{"name":"b"}'], 2)).toEqual({
      malformed: false,
      value: [{}, {}],
    });
    expect(normalizeFileInfo(['{"caption":"c"}'], 1)).toEqual({
      malformed: false,
      value: { caption: "c" },
    });
  });

  it.each([
    ["broken JSON", "{", 1],
    ["an array of JSON", "[]", 1],
    ["an unknown key", '{"folder":3}', 1],
    ["a non-string text", '{"caption":3}', 1],
    ["a non-string name", '{"name":{}}', 1],
    ["a focal point out of range", '{"focalPoint":{"x":101,"y":0}}', 1],
    ["more entries than files", ["{}", "{}"], 1],
    ["a single object for several files", "{}", 2],
    ["an empty list", [], 1],
  ])("refuses %s", (_label, raw, count) => {
    expect(normalizeFileInfo(raw, count)).toEqual({ malformed: true });
  });
});

describe("uploadProfileOf", () => {
  it("gives moderators and department heads the document profile, everyone else images", () => {
    const of = (type: string) => uploadProfileOf({ role: { type } });
    expect(of("admin_role")).toBe("document");
    expect(of("editor")).toBe("document");
    expect(of("department_head")).toBe("document");
    for (const type of ["team_lead", "member", "guest", "authenticated", "nope"]) {
      expect(of(type), type).toBe("image");
    }
    expect(uploadProfileOf(null)).toBe("image");
  });
});

describe("sniffUpload", () => {
  const fileOf = (bytes: Uint8Array, size = bytes.length): RandomAccessFile => ({
    size,
    read: async (position, length) => bytes.subarray(position, position + length),
  });
  const sniff = (bytes: Uint8Array, profile: UploadProfile, size?: number) =>
    sniffUpload(fileOf(bytes, size), profile);

  it("stores PDF, DOCX, XLSX, PPTX and images for the document profile", async () => {
    const cases: Array<[Uint8Array, UploadFormat]> = [
      [minimalPdf(), "pdf"],
      [minimalDocx(), "docx"],
      [minimalXlsx(), "xlsx"],
      [minimalPptx(), "pptx"],
      [ooxmlFixture("excel-desktop.xlsx"), "xlsx"],
      [PNG_1PX, "png"],
    ];
    for (const [bytes, format] of cases) {
      expect(await sniff(bytes, "document"), format).toEqual({ ok: true, format });
    }
  });

  it("keeps the image profile to images", async () => {
    expect(await sniff(PNG_1PX, "image")).toEqual({ ok: true, format: "png" });
    for (const bytes of [minimalPdf(), minimalDocx(), ooxmlFixture("powerpoint-desktop.pptx")]) {
      expect(await sniff(bytes, "image")).toMatchObject({ ok: false, code: "fileType" });
    }
  });

  it("refuses a PDF that is also a zip, and every disguise", async () => {
    const polyglot = Buffer.concat([minimalPdf(), minimalDocx()]);
    expect(await sniff(polyglot, "document")).toEqual({
      ok: false,
      code: "fileType",
      reason: "a PDF that is also a zip",
    });
    for (const text of [
      "MZ\u0090\u0000 executable",
      "<!DOCTYPE html><script>",
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "PK\u0003\u0004 fake zip without a directory",
      "GIF89a............",
      "",
    ]) {
      expect(await sniff(Buffer.from(text, "latin1"), "document"), text).toMatchObject({
        ok: false,
        code: "fileType",
      });
    }
  });

  it("caps images at 5 MB in every profile and documents at 20 MB", async () => {
    expect(await sniff(PNG_1PX, "document", IMAGE_MAX_BYTES)).toEqual({ ok: true, format: "png" });
    expect(await sniff(PNG_1PX, "document", IMAGE_MAX_BYTES + 1)).toMatchObject({
      ok: false,
      code: "fileTooLarge",
    });
    expect(await sniff(PNG_1PX, "image", IMAGE_MAX_BYTES + 1)).toMatchObject({
      code: "fileTooLarge",
    });
    expect(await sniff(minimalPdf(), "document", DOCUMENT_MAX_BYTES + 1)).toMatchObject({
      ok: false,
      code: "fileTooLarge",
    });
  });

  it("answers an unreadable file with fileType, never an exception", async () => {
    const broken: RandomAccessFile = {
      size: 100,
      read: async () => {
        throw new Error("EIO");
      },
    };
    expect(await sniffUpload(broken, "document")).toEqual({
      ok: false,
      code: "fileType",
      reason: "unreadable",
    });
  });
});
