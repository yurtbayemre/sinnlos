/**
 * The early checks of a document file (deep-dive decision 06 §L6, §E1;
 * batch 16 plan, lane 16C item 2; contract K11): what the file input and
 * the upload action refuse before a byte is sent, so a wrong pick is
 * explained at once instead of after a 20 MB round trip. Pure; used by the
 * client form and the Server Action alike.
 *
 *   - the name's extension must be one of the `accept` list
 *     (DOCUMENT_UPLOAD_ACCEPT): otherwise `fileType`;
 *   - the size must be at most the format's cap: 20 MB for PDF and Office
 *     (DOCUMENT_MAX_BYTES), 5 MB for images (IMAGE_MAX_BYTES): otherwise
 *     `fileTooLarge`; an empty file is no document (`fileType`).
 *
 * UX only. The cms decides by CONTENT (the sniff of §E1: a renamed
 * `.xlsm` passes here and is refused there with the same `fileType`), and
 * the browser's declared type is ignored on both sides.
 */
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_UPLOAD_ACCEPT,
  IMAGE_MAX_BYTES,
  type UploadFileCode,
} from "@sinnlos/domain";

/** The extensions of the `accept` list, lower case with the dot. */
export const DOCUMENT_UPLOAD_EXTENSIONS: readonly string[] = DOCUMENT_UPLOAD_ACCEPT.split(",");

export const IMAGE_UPLOAD_ACCEPT = ".jpg,.jpeg,.png,.webp";
const IMAGE_EXTENSIONS = new Set(IMAGE_UPLOAD_ACCEPT.split(","));

/** The extension of a file name, lower case with the dot ("" without one). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** The size cap of a file with this name, or null when its type is not accepted. */
export function uploadCapOf(name: string): number | null {
  const extension = fileExtension(name);
  if (!DOCUMENT_UPLOAD_EXTENSIONS.includes(extension)) return null;
  return IMAGE_EXTENSIONS.has(extension) ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES;
}

/** The refusal code of a picked file, or null when it may be sent. */
export function checkUploadFile(
  file: { name: string; size: number },
  imageOnly = false,
): UploadFileCode | null {
  if (imageOnly && !IMAGE_EXTENSIONS.has(fileExtension(file.name))) return "fileType";
  const cap = uploadCapOf(file.name);
  if (cap === null || !(file.size > 0)) return "fileType";
  return file.size > cap ? "fileTooLarge" : null;
}

/** A byte count for people: "512 B", "1.5 KB", "20.0 MB" (binary units, like the caps). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strapi stores a file's `size` in KILOBYTES: the same text for a stored file. */
export function formatKilobytes(kilobytes: number | null | undefined): string {
  return typeof kilobytes === "number" && kilobytes > 0 ? formatBytes(kilobytes * 1024) : "";
}
