/**
 * Pure rules of the hardened content-API upload (POST /api/upload), used by
 * extensions/upload/strapi-server.ts (FX03). No Strapi runtime and no I/O:
 * the extension reads the temp file's first bytes / size and hands them in,
 * so every rule here is unit-testable (upload-guard.test.ts).
 *
 * Why each rule exists is documented in the extension header; in short:
 *  - body allowlist: core formatFileInfo turns the multipart fields
 *    ref/refId/field into a files_related_mph link on ANY entry, and `path`
 *    into the provider upload path — none of that is ever wanted here;
 *  - bounded count/size;
 *  - magic-byte sniff (JPEG/PNG/WebP only — no SVG, no GIF);
 *  - canonical filename: core stores and serves by the filename EXTENSION
 *    when it disagrees with the content (@strapi/upload 5.49
 *    mime-validation.js:221-224, services/upload.js:86), so a JPEG-magic
 *    `x.pdf` would be stored and served as application/pdf.
 */

export const MAX_FILES_PER_REQUEST = 4;
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
/** Bytes the sniffer needs (the WebP signature ends at offset 12). */
export const SNIFF_BYTES = 12;

/** The only multipart text field the content-API upload accepts. */
export const ALLOWED_UPLOAD_BODY_KEYS: ReadonlySet<string> = new Set(["fileInfo"]);

export type AllowedImageMime = "image/jpeg" | "image/png" | "image/webp";

/** Canonical extension per allowed type — what the stored file is named. */
export const CANONICAL_EXTENSION: Readonly<Record<AllowedImageMime, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Sniff the real content type from the file's first bytes. Returns the
 * canonical mime for the three allowed formats, or null for anything else
 * (including a head shorter than SNIFF_BYTES).
 */
export function sniffImageMime(head: Uint8Array): AllowedImageMime | null {
  if (head.length < SNIFF_BYTES) return null;
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (PNG_MAGIC.every((byte, i) => head[i] === byte)) return "image/png";
  // WebP: "RIFF" <size> "WEBP"
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * `<basename>.<canonical ext>`: directory parts (either separator) and the
 * client's extension are dropped, so the stored ext, the stored mime and the
 * content agree. An empty stem (".jpg", "", "/") falls back to "image".
 * Characters core rejects (reserved/control chars) are left for core's own
 * isValidFilename check — fail closed, not silently rewritten.
 */
export function canonicalFilename(originalName: string, mime: AllowedImageMime): string {
  const base = originalName.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = (dot >= 0 ? base.slice(0, dot) : base).trim();
  return `${stem || "image"}${CANONICAL_EXTENSION[mime]}`;
}

/** formidable hands a single file as an object and several as an array. */
export function toFileArray<T>(filesInput: T | T[] | null | undefined): T[] {
  if (Array.isArray(filesInput)) return filesInput;
  return filesInput ? [filesInput] : [];
}

/**
 * True when the multipart body carries nothing but `fileInfo`. An absent
 * body is fine (the web sends only `files`); a non-object body is not.
 */
export function isAllowedUploadBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body !== "object" || Array.isArray(body)) return false;
  return Object.keys(body).every((key) => ALLOWED_UPLOAD_BODY_KEYS.has(key));
}

/** Declared size when formidable reported a finite number, else null (→ stat). */
export function declaredSize(size: unknown): number | null {
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

export function exceedsSizeLimit(size: number): boolean {
  return size > MAX_FILE_BYTES;
}

/** Numeric file ids from the core controller's ctx.body (array or single). */
export function createdFileIds(body: unknown): number[] {
  const items = Array.isArray(body) ? body : body ? [body] : [];
  const ids: number[] = [];
  for (const item of items) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === "number") ids.push(id);
  }
  return ids;
}
