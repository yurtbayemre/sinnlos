import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string | undefined | null): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Strip HTML tags from Strapi richtext for plain-text previews. */
export function stripHtml(s?: string | null): string {
  if (!s) return "";
  return s.replace(/<[^>]*>?/gm, "");
}

/** Placeholder origin (RFC 2606 `.invalid`) that safeInternalPath resolves against. */
const INTERNAL_ORIGIN = "http://internal.invalid";

/**
 * True for any C0 control character, DEL or a backslash. Browsers strip
 * TAB/LF/CR while parsing a URL and treat `\` like `/` in http(s) URLs, so a
 * value such as "/<TAB>/evil.example" becomes "//evil.example" — a
 * protocol-relative URL — only AFTER a naive prefix check has passed it.
 */
function hasUnsafeUrlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Validate a user-supplied redirect target (e.g. the ?from= param the
 * route guard appends to /sign-in). Only same-origin absolute paths are
 * allowed — external URLs, protocol-relative "//host" and backslash
 * variants fall back to `fallback` to avoid open redirects. Auth pages
 * are excluded so a stale ?from can't bounce users back to the form.
 *
 * FX10: the sign-in page hands the result straight to redirect(), which
 * Next writes verbatim into the Location header (Node accepts HTAB there).
 * Hence (1) control characters, DEL and backslashes anywhere are rejected
 * outright, and (2) the value is resolved with the WHATWG parser (the one
 * browsers use) and must keep the placeholder origin and a pathname with a
 * single leading slash — this also catches dot-segment tricks such as
 * "/x/..//evil.example", whose pathname normalises to "//evil.example".
 * The original string is returned: once it passes (1) and (2) a browser
 * resolves it to the same same-origin URL.
 */
export function safeInternalPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (hasUnsafeUrlChar(value)) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;

  let url: URL;
  try {
    url = new URL(value, INTERNAL_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== INTERNAL_ORIGIN) return fallback;
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return fallback;

  // Compared on the parsed pathname, so ?query and #hash suffixes (and
  // dot-segment spellings) of the auth pages are excluded as well.
  if (url.pathname === "/sign-in" || url.pathname === "/register") return fallback;
  return value;
}
