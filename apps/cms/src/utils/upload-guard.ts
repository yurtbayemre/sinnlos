/**
 * Pure rules of the hardened content-API upload (POST /api/upload), used by
 * extensions/upload/strapi-server.ts (FX03; deep-dive decision 06 §E1 with
 * owner amendment 2, batch 16 lane 16A). No Strapi runtime: the extension
 * hands in the temp file as a RandomAccessFile (positional reads through
 * one file handle), so every rule here is unit-testable
 * (upload-guard.test.ts, on the spike-11 fixtures).
 *
 * Why each rule exists is documented in the extension header; in short:
 *  - body allowlist: core formatFileInfo turns the multipart fields
 *    ref/refId/field into a files_related_mph link on ANY entry, and `path`
 *    into the provider upload path; none of that is ever wanted here.
 *    `fileInfo` is checked and its `name` dropped: core prefers it over the
 *    file name (@strapi/upload 5.57 services/upload.js formatFileInfo), so
 *    it would undo the canonical name;
 *  - two PROFILES, by role: moderators and department heads may upload the
 *    whole table of @sinnlos/domain uploads.ts (PDF, DOCX, XLSX, PPTX up to
 *    20 MB; JPEG, PNG, WebP up to 5 MB), one PDF or Office file per request;
 *    every other role keeps the image profile (JPEG, PNG, WebP, 5 MB, up to
 *    4 files: one marketplace ad's worth);
 *  - the format comes from the CONTENT: the image magic bytes; a PDF by
 *    `%PDF-` at offset 0 and no zip end record a zip reader could take (a
 *    PDF that is also a zip is refused, amendment row A6); DOCX, XLSX and
 *    PPTX by the one Office Open XML rule (utils/upload-ooxml.ts). No SVG
 *    (stored XSS), no GIF (decompression bombs), nothing else;
 *  - canonical mime and file name from the table: core stores and serves
 *    by the file name's extension when it disagrees with the content
 *    (mime-validation.js), so a JPEG-magic `x.pdf` would otherwise be
 *    stored and served as application/pdf.
 */

import {
  CLASSIFIED_MAX_IMAGES,
  CLASSIFIED_MAX_IMAGE_BYTES,
  DEPARTMENT_AUTHOR_ROLES,
  DOCUMENT_MAX_BYTES,
  IMAGE_MAX_BYTES,
  MODERATORS,
  UPLOAD_FORMAT_SPECS,
  hasRole,
  type ClassifiedImageType,
  type RoleHolder,
  type UploadFileCode,
  type UploadFormat,
} from "@sinnlos/domain";
import { strings } from "@strapi/utils";

import { sniffOfficeFormat } from "./upload-ooxml";
import { ZipRefusal, hasZipEndRecord, type RandomAccessFile } from "./upload-zip";

// The marketplace image limits of @sinnlos/domain (SH01), shared with the
// web ad form: one ad's worth of files per request, 5 MB each.
export const MAX_FILES_PER_REQUEST = CLASSIFIED_MAX_IMAGES;
export const MAX_FILE_BYTES = CLASSIFIED_MAX_IMAGE_BYTES;
/** Bytes the sniffer needs (the WebP signature ends at offset 12). */
export const SNIFF_BYTES = 12;

/** The only multipart text field the content-API upload accepts. */
export const ALLOWED_UPLOAD_BODY_KEYS: ReadonlySet<string> = new Set(["fileInfo"]);

/** JPEG, PNG or WebP: CLASSIFIED_IMAGE_TYPES of @sinnlos/domain. */
export type AllowedImageMime = ClassifiedImageType;

/** Canonical extension per image type (the table of @sinnlos/domain, images only). */
export const CANONICAL_EXTENSION: Readonly<Record<AllowedImageMime, string>> = {
  "image/jpeg": UPLOAD_FORMAT_SPECS.jpeg.extension,
  "image/png": UPLOAD_FORMAT_SPECS.png.extension,
  "image/webp": UPLOAD_FORMAT_SPECS.webp.extension,
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_MAGIC = "%PDF-";
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Sniff the real content type from the file's first bytes. Returns the
 * canonical mime for the three image formats, or null for anything else
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

const IMAGE_FORMAT_OF_MIME: Readonly<Record<AllowedImageMime, UploadFormat>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Who may upload what (§E1): the role decides, attaching is the allowlist's job. */
export type UploadProfile = "image" | "document";

/** Moderators and department heads get the document profile; everyone else images. */
export function uploadProfileOf(user: RoleHolder | null | undefined): UploadProfile {
  return hasRole(user, MODERATORS) || hasRole(user, DEPARTMENT_AUTHOR_ROLES) ? "document" : "image";
}

/** The largest file a profile can accept at all, checked before any read. */
export function profileMaxBytes(profile: UploadProfile): number {
  return profile === "document" ? DOCUMENT_MAX_BYTES : IMAGE_MAX_BYTES;
}

/** A sniff's answer: the stored format, or the refusal code and a reason for the log. */
export type SniffResult =
  { ok: true; format: UploadFormat } | { ok: false; code: UploadFileCode; reason: string };

const refusedType = (reason: string): SniffResult => ({ ok: false, code: "fileType", reason });

/**
 * The format of one uploaded file under `profile`, read from its content
 * through `file` (never the whole file). Any error refuses the file
 * (`fileType`); an image above 5 MB answers `fileTooLarge`. The caller has
 * already checked the profile's size cap before calling.
 */
export async function sniffUpload(
  file: RandomAccessFile,
  profile: UploadProfile,
): Promise<SniffResult> {
  try {
    const head = await file.read(0, SNIFF_BYTES);
    const image = sniffImageMime(head);
    if (image) {
      const format = IMAGE_FORMAT_OF_MIME[image];
      return file.size > UPLOAD_FORMAT_SPECS[format].maxBytes
        ? { ok: false, code: "fileTooLarge", reason: "image above 5 MB" }
        : { ok: true, format };
    }
    if (profile !== "document") return refusedType("not an image");
    if (file.size > DOCUMENT_MAX_BYTES) {
      return { ok: false, code: "fileTooLarge", reason: "document above 20 MB" };
    }
    if (ascii(head, 0, PDF_MAGIC.length) === PDF_MAGIC) {
      return (await hasZipEndRecord(file))
        ? refusedType("a PDF that is also a zip")
        : { ok: true, format: "pdf" };
    }
    if (ZIP_LOCAL_HEADER.every((byte, i) => head[i] === byte)) {
      return { ok: true, format: await sniffOfficeFormat(file) };
    }
    return refusedType("not a format of the table");
  } catch (error) {
    return refusedType(error instanceof ZipRefusal ? error.reason : "unreadable");
  }
}

/**
 * The slug core puts in front of the stored hash: @strapi/upload 5.57
 * image-manipulation.js generateFileName → `${nameToSlug(stem)}_<10 hex>`,
 * with exactly these options.
 */
export function uploadHashSlug(stem: string): string {
  return strings.nameToSlug(stem, { separator: "_", lowercase: false });
}

/**
 * `<basename><canonical ext>` for a format of the table: directory parts
 * (either separator) and the client's extension are dropped, so the stored
 * ext, the stored mime and the content agree. A stem core cannot slug falls
 * back to "image" (images) or "document" (PDF and Office): an empty one
 * (".jpg", "", "/"), but also a CJK, emoji or punctuation-only one ("写真",
 * "🙂", "---"). Core would slug it to "" and store the file as
 * `_<hex>.<ext>`, a name the web /uploads proxy 404'd before its segment
 * rule allowed a leading `_` (final review C2-UPLOAD-EMPTY-SLUG).
 * Characters core rejects (reserved/control chars) in an otherwise
 * sluggable stem are left for core's own isValidFilename check, which the
 * extension answers as an invalid file: fail closed, not silently
 * rewritten.
 */
export function canonicalFilename(originalName: string, format: UploadFormat): string {
  const spec = UPLOAD_FORMAT_SPECS[format];
  const base = originalName.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = (dot >= 0 ? base.slice(0, dot) : base).trim();
  const fallback = spec.kind === "image" ? "image" : "document";
  return `${uploadHashSlug(stem) ? stem : fallback}${spec.extension}`;
}

/** formidable hands a single file as an object and several as an array. */
export function toFileArray<T>(filesInput: T | T[] | null | undefined): T[] {
  if (Array.isArray(filesInput)) return filesInput;
  return filesInput ? [filesInput] : [];
}

/**
 * The multipart fields other than `fileInfo`, sorted (refused by key). An
 * absent body is fine (the web sends only `files`); a body that is no
 * object answers `["body"]`.
 */
export function refusedBodyKeys(body: unknown): string[] {
  if (body === undefined || body === null) return [];
  if (typeof body !== "object" || Array.isArray(body)) return ["body"];
  return Object.keys(body)
    .filter((key) => !ALLOWED_UPLOAD_BODY_KEYS.has(key))
    .sort();
}

/** True when the multipart body carries nothing but `fileInfo`. */
export function isAllowedUploadBody(body: unknown): boolean {
  return refusedBodyKeys(body).length === 0;
}

/** The `fileInfo` keys core accepts (validation/content-api/upload.js); `name` is dropped. */
const FILE_INFO_TEXT_KEYS = ["alternativeText", "caption"] as const;

type FileInfo = { alternativeText?: string | null; caption?: string | null; focalPoint?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const isOptionalText = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === "string";

function isFocalPoint(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const inRange = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
  return keys.length === 2 && inRange(value.x) && inRange(value.y);
}

/** One `fileInfo` object: the allowed keys only, `name` dropped; null when malformed. */
function normalizeOneFileInfo(raw: unknown): FileInfo | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isPlainObject(value)) return null;
  const allowed = new Set<string>(["name", ...FILE_INFO_TEXT_KEYS, "focalPoint"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!isOptionalText(value.name)) return null;
  const info: FileInfo = {};
  for (const key of FILE_INFO_TEXT_KEYS) {
    if (!isOptionalText(value[key])) return null;
    if (value[key] !== undefined) info[key] = value[key] as string | null;
  }
  if (!isFocalPoint(value.focalPoint)) return null;
  if (value.focalPoint !== undefined) info.focalPoint = value.focalPoint;
  return info;
}

/**
 * The checked `fileInfo` for `fileCount` files: undefined when absent, an
 * object for one file, an array (at most one entry per file) for several;
 * `name` is dropped from every entry. `{ malformed: true }` for anything
 * core would refuse or fail on (a JSON parse error is a 500 in core).
 */
export function normalizeFileInfo(
  raw: unknown,
  fileCount: number,
): { malformed: true } | { malformed: false; value: FileInfo | FileInfo[] | undefined } {
  if (raw === undefined || raw === null || raw === "")
    return { malformed: false, value: undefined };
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0 || list.length > Math.max(fileCount, 1)) return { malformed: true };
  if (!Array.isArray(raw) && fileCount > 1) return { malformed: true };
  const infos: FileInfo[] = [];
  for (const item of list) {
    const info = normalizeOneFileInfo(item);
    if (!info) return { malformed: true };
    infos.push(info);
  }
  return { malformed: false, value: fileCount > 1 ? infos : infos[0] };
}

/** Declared size when formidable reported a finite number, else null (→ stat). */
export function declaredSize(size: unknown): number | null {
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
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
