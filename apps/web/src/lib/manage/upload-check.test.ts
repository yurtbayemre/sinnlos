import { describe, expect, it } from "vitest";
import { DOCUMENT_MAX_BYTES, DOCUMENT_UPLOAD_ACCEPT, IMAGE_MAX_BYTES } from "@sinnlos/domain";
import {
  checkUploadFile,
  DOCUMENT_UPLOAD_EXTENSIONS,
  fileExtension,
  formatBytes,
  formatKilobytes,
  uploadCapOf,
} from "./upload-check";

/**
 * The file input's early checks (decision 06 §L6 step 1; batch 16 plan
 * 16C tests "the file input"): the five kinds of file of the accept list
 * (PDF, DOCX, XLSX, PPTX, images) at their caps, 20 MB for PDF and Office
 * and 5 MB for images, decided by the extension (the cms decides by the
 * content), anything else `fileType`.
 */
const MB = 1024 * 1024;

describe("checkUploadFile", () => {
  it("accepts the five kinds up to their caps", () => {
    for (const name of ["a.pdf", "a.docx", "a.xlsx", "a.pptx"]) {
      expect(checkUploadFile({ name, size: 20 * MB }), name).toBeNull();
      expect(checkUploadFile({ name, size: 20 * MB + 1 }), name).toBe("fileTooLarge");
    }
    for (const name of ["a.jpg", "a.jpeg", "a.png", "a.webp", "A.PNG"]) {
      expect(checkUploadFile({ name, size: 5 * MB }), name).toBeNull();
      expect(checkUploadFile({ name, size: 5 * MB + 1 }), name).toBe("fileTooLarge");
    }
  });

  it("refuses every other type, also a macro or template variant by its name, and an empty file", () => {
    for (const name of [
      "a.docm",
      "a.xlsm",
      "a.pptm",
      "a.xlsb",
      "a.dotx",
      "a.ppsx",
      "a.doc",
      "a.exe",
      "a.pdf.exe",
      "pdf",
      ".pdf",
      "",
    ]) {
      expect(checkUploadFile({ name, size: 100 }), name).toBe("fileType");
    }
    expect(checkUploadFile({ name: "a.pdf", size: 0 })).toBe("fileType");
  });

  it("follows the domain's accept list and caps", () => {
    expect(DOCUMENT_UPLOAD_EXTENSIONS.join(",")).toBe(DOCUMENT_UPLOAD_ACCEPT);
    expect(uploadCapOf("x.PDF")).toBe(DOCUMENT_MAX_BYTES);
    expect(uploadCapOf("x.webp")).toBe(IMAGE_MAX_BYTES);
    expect(uploadCapOf("x.zip")).toBeNull();
    expect(fileExtension("archive.tar.GZ")).toBe(".gz");
    expect(fileExtension("README")).toBe("");
  });
});

describe("formatBytes", () => {
  it("writes sizes in binary units; Strapi's kilobytes the same way", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * MB)).toBe("20.0 MB");
    expect(formatKilobytes(2048)).toBe("2.0 MB");
    expect(formatKilobytes(0)).toBe("");
    expect(formatKilobytes(null)).toBe("");
  });
});
