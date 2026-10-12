/**
 * Marketplace (classified ad) limits, one set of numbers for both apps
 * (SH01). The cms enforces them: the classified controller (images per ad),
 * utils/classified-expiry.ts (lifetime clamp), and the hardened content-API
 * upload (utils/upload-guard.ts: files per request, bytes per file, the
 * image types it sniffs). The web ad form and classified actions
 * (lib/classified-shared.ts) check the same numbers for UX only; the cms is
 * authoritative.
 */

/** Most images on one ad, and most files in one content-API upload request. */
export const CLASSIFIED_MAX_IMAGES = 4;

/** Largest ad image, in MB (the web form shows this number). */
export const CLASSIFIED_MAX_IMAGE_MB = 5;

/** Largest ad image, in bytes. */
export const CLASSIFIED_MAX_IMAGE_BYTES = CLASSIFIED_MAX_IMAGE_MB * 1024 * 1024;

/**
 * The only ad image types: JPEG, PNG, WebP. The cms verifies them by magic
 * bytes; no SVG (stored XSS) and no GIF (decompression bombs).
 */
export const CLASSIFIED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ClassifiedImageType = (typeof CLASSIFIED_IMAGE_TYPES)[number];

/** Lifetime of an ad whose expiry is missing or invalid, in days from today. */
export const CLASSIFIED_DEFAULT_LIFETIME_DAYS = 30;

/** Longest lifetime of an ad, in days from today (the cms clamps to it). */
export const CLASSIFIED_MAX_LIFETIME_DAYS = 90;
