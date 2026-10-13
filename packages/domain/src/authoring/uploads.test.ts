import { describe, expect, it } from "vitest";

import { CLASSIFIED_IMAGE_TYPES, CLASSIFIED_MAX_IMAGE_BYTES } from "../classified.js";
import { AUTHORING_FIELD_CODES } from "./codes.js";
import {
  DOCUMENT_FILE_MIME_TYPES,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_UPLOAD_ACCEPT,
  IMAGE_FORMATS,
  IMAGE_MAX_BYTES,
  OFFICE_FORMATS,
  OFFICE_FORMAT_SPECS,
  UPLOAD_FILE_CODES,
  UPLOAD_FORMATS,
  UPLOAD_FORMAT_SPECS,
  UPLOAD_HTTP_STATUS,
  uploadFormatOfMime,
} from "./uploads.js";

/**
 * Contract K11 and K14 of batch 16 (decision 06 §E1, amendment 2): the
 * table the cms stores uploads by and the web's file input checks against.
 * The cms pins that `mime-types` maps every stored extension to its stored
 * mime (apps/cms/src/extensions/upload/upload-validation.contract.test.ts).
 */
describe("the upload table (K11)", () => {
  it("holds exactly the seven formats of §E1 with their stored mime and extension", () => {
    expect(
      Object.fromEntries(
        UPLOAD_FORMATS.map((format) => [
          format,
          [UPLOAD_FORMAT_SPECS[format].mime, UPLOAD_FORMAT_SPECS[format].extension],
        ]),
      ),
    ).toEqual({
      pdf: ["application/pdf", ".pdf"],
      docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
      xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
      pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
      jpeg: ["image/jpeg", ".jpg"],
      png: ["image/png", ".png"],
      webp: ["image/webp", ".webp"],
    });
  });

  it("caps PDF and Office at 20 MB and images at the marketplace's 5 MB", () => {
    expect(DOCUMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(IMAGE_MAX_BYTES).toBe(CLASSIFIED_MAX_IMAGE_BYTES);
    for (const format of UPLOAD_FORMATS) {
      const spec = UPLOAD_FORMAT_SPECS[format];
      expect(spec.maxBytes, format).toBe(
        spec.kind === "image" ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES,
      );
    }
  });

  it("keeps the image formats equal to the marketplace's", () => {
    expect(IMAGE_FORMATS.map((format) => UPLOAD_FORMAT_SPECS[format].mime)).toEqual([
      ...CLASSIFIED_IMAGE_TYPES,
    ]);
  });

  it("names one main part per Office format, in that format's folder", () => {
    expect([...OFFICE_FORMATS]).toEqual(["docx", "xlsx", "pptx"]);
    for (const format of OFFICE_FORMATS) {
      const spec = OFFICE_FORMAT_SPECS[format];
      expect(spec.mainPart.startsWith(`/${spec.folder}/`), format).toBe(true);
      expect(spec.mainContentType.endsWith(".main+xml"), format).toBe(true);
      expect(spec.mainContentType.toLowerCase()).not.toContain("macroenabled");
      // The main content type is the stored mime plus ".main+xml".
      expect(spec.mainContentType).toBe(`${UPLOAD_FORMAT_SPECS[format].mime}.main+xml`);
    }
  });

  it("lists every stored mime once as a document file mime, and maps it back", () => {
    expect(new Set(DOCUMENT_FILE_MIME_TYPES).size).toBe(UPLOAD_FORMATS.length);
    for (const format of UPLOAD_FORMATS) {
      expect(uploadFormatOfMime(UPLOAD_FORMAT_SPECS[format].mime)).toBe(format);
    }
    expect(uploadFormatOfMime("application/vnd.ms-excel.sheet.macroEnabled.12")).toBeNull();
    expect(uploadFormatOfMime(undefined)).toBeNull();
  });

  it("accepts in the file input exactly the stored extensions plus .jpeg", () => {
    const accepted = DOCUMENT_UPLOAD_ACCEPT.split(",");
    expect(new Set(accepted).size).toBe(accepted.length);
    expect(accepted.sort()).toEqual(
      [...UPLOAD_FORMATS.map((format) => UPLOAD_FORMAT_SPECS[format].extension), ".jpeg"].sort(),
    );
  });
});

describe("the upload answers (K14)", () => {
  it("refuses a file with fileType or fileTooLarge, both authoring codes", () => {
    expect([...UPLOAD_FILE_CODES]).toEqual(["fileType", "fileTooLarge"]);
    for (const code of UPLOAD_FILE_CODES) {
      expect((AUTHORING_FIELD_CODES as readonly string[]).includes(code), code).toBe(true);
    }
  });

  it("pins the statuses", () => {
    expect(UPLOAD_HTTP_STATUS).toEqual({
      created: 201,
      refused: 400,
      replaceNotAllowed: 403,
      bodyTooLarge: 413,
    });
  });
});
