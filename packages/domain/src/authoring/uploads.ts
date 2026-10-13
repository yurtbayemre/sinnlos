/**
 * The upload profile of v2 authoring (deep-dive decision 06 §E1, owner
 * amendment 2; batch 16 plan, contracts K11 and K14). One table for the cms
 * wrapper (apps/cms/src/extensions/upload/strapi-server.ts, which sniffs
 * the content and stores the file under the table's mime and extension),
 * the media claims (the mimes a document file may have) and the web file
 * input (the `accept` string and the per-type size check).
 *
 * THE TABLE IS THE ONLY MAPPING. The client's declared type and file
 * extension are ignored: the cms decides the format from the bytes (a PDF
 * by `%PDF-` at offset 0 and no zip end record at the end; DOCX, XLSX and
 * PPTX by the one Office Open XML rule; JPEG, PNG and WebP by their magic
 * bytes) and stores `<basename><extension>` with the table's mime.
 *
 * WHO. Moderators and department heads (the document profile) may upload
 * every format of the table; every other role keeps the image profile
 * (JPEG, PNG, WebP, up to CLASSIFIED_MAX_IMAGES per request).
 *
 * THE HTTP ANSWERS of POST /api/upload (K14), for every role:
 *   - 201: an array with exactly one element per uploaded file. A request
 *     with a PDF or Office file carries exactly that one file, so the
 *     answer has exactly one element; anything else is a failure;
 *   - 400 `ValidationError` with `details.keys` and `details.codes`
 *     (codes.ts): a refused file answers `keys: ["file"]` with
 *     `codes.file` = `fileType` (not a format of the profile, or not a
 *     clean one: macro-enabled, template, slideshow, binary, a disguise)
 *     or `fileTooLarge` (above the format's cap); a request without a
 *     file `required`, too many files `invalid`; a malformed `fileInfo`
 *     answers `keys: ["fileInfo"]`; any other multipart field answers its
 *     key (no code);
 *   - 403: `?id=` (replacing or renaming an existing file) is not allowed;
 *   - 413: a body above 50 MB, refused by the body parser before the
 *     wrapper runs (the web maps it to `fileTooLarge`).
 *   Operational failures (storage, database) stay 5xx.
 */

/** The formats an upload can be stored as. */
export const UPLOAD_FORMATS = ["pdf", "docx", "xlsx", "pptx", "jpeg", "png", "webp"] as const;

export type UploadFormat = (typeof UPLOAD_FORMATS)[number];

/** The Office Open XML formats (one rule for the three). */
export const OFFICE_FORMATS = ["docx", "xlsx", "pptx"] as const;

export type OfficeFormat = (typeof OFFICE_FORMATS)[number];

/** Largest PDF or Office upload: 20 MB (owner answer 6, amendment 2). */
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Largest image upload, for every role: 5 MB, the marketplace limit
 * (CLASSIFIED_MAX_IMAGE_BYTES of classified.ts; uploads.test.ts pins the
 * equality, since a domain module imports siblings only).
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface UploadFormatSpec {
  /** Stored mime type. */
  mime: string;
  /** Stored extension, with the dot. */
  extension: string;
  /** The cap for this format, in bytes. */
  maxBytes: number;
  /** "document": PDF and Office (document profile only); "image": every profile. */
  kind: "document" | "image";
}

/** One row per format (§E1). */
export const UPLOAD_FORMAT_SPECS: Readonly<Record<UploadFormat, UploadFormatSpec>> = {
  pdf: {
    mime: "application/pdf",
    extension: ".pdf",
    maxBytes: DOCUMENT_MAX_BYTES,
    kind: "document",
  },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
    maxBytes: DOCUMENT_MAX_BYTES,
    kind: "document",
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
    maxBytes: DOCUMENT_MAX_BYTES,
    kind: "document",
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: ".pptx",
    maxBytes: DOCUMENT_MAX_BYTES,
    kind: "document",
  },
  jpeg: { mime: "image/jpeg", extension: ".jpg", maxBytes: IMAGE_MAX_BYTES, kind: "image" },
  png: { mime: "image/png", extension: ".png", maxBytes: IMAGE_MAX_BYTES, kind: "image" },
  webp: { mime: "image/webp", extension: ".webp", maxBytes: IMAGE_MAX_BYTES, kind: "image" },
};

export interface OfficeFormatSpec {
  /** The folder of the package the main part lies in (`word`, `xl`, `ppt`). */
  folder: string;
  /** The conventional main part name. */
  mainPart: string;
  /** The main part's content type in `[Content_Types].xml`. */
  mainContentType: string;
}

/** The Office Open XML main parts (§E1, the rule's step 3). */
export const OFFICE_FORMAT_SPECS: Readonly<Record<OfficeFormat, OfficeFormatSpec>> = {
  docx: {
    folder: "word",
    mainPart: "/word/document.xml",
    mainContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  },
  xlsx: {
    folder: "xl",
    mainPart: "/xl/workbook.xml",
    mainContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  },
  pptx: {
    folder: "ppt",
    mainPart: "/ppt/presentation.xml",
    mainContentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  },
};

/** The stored mimes a document's file may have (§E2: every format of the table). */
export const DOCUMENT_FILE_MIME_TYPES: readonly string[] = UPLOAD_FORMATS.map(
  (format) => UPLOAD_FORMAT_SPECS[format].mime,
);

/** The image formats every profile accepts. */
export const IMAGE_FORMATS: readonly UploadFormat[] = UPLOAD_FORMATS.filter(
  (format) => UPLOAD_FORMAT_SPECS[format].kind === "image",
);

/** The web file input's `accept` for a document file. */
export const DOCUMENT_UPLOAD_ACCEPT = ".pdf,.docx,.xlsx,.pptx,.jpg,.jpeg,.png,.webp";

/** The format stored under `mime`, or null. */
export function uploadFormatOfMime(mime: unknown): UploadFormat | null {
  if (typeof mime !== "string") return null;
  return UPLOAD_FORMATS.find((format) => UPLOAD_FORMAT_SPECS[format].mime === mime) ?? null;
}

/** The `details.keys` entry of a refused file, and of a refused `fileInfo`. */
export const UPLOAD_FILE_KEY = "file";
export const UPLOAD_FILE_INFO_KEY = "fileInfo";

/** The codes a refused file carries (`details.codes.file`), besides `required` and `invalid`. */
export const UPLOAD_FILE_CODES = ["fileType", "fileTooLarge"] as const;

export type UploadFileCode = (typeof UPLOAD_FILE_CODES)[number];

/** The statuses of POST /api/upload (K14). */
export const UPLOAD_HTTP_STATUS = {
  created: 201,
  refused: 400,
  replaceNotAllowed: 403,
  bodyTooLarge: 413,
} as const;
