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

/** Private-use markers around a protected piece (an escape or a code span). */
const HOLD_OPEN = "\uE000";
const HOLD_CLOSE = "\uE001";

/**
 * Most characters of a body stripMarkdown reads by default; the rest is cut
 * before any rule runs. A preview shows a few lines, and some rules scan
 * from an opener without a closer to the end of its line, which is
 * quadratic on a pathological line (about 0.8 s for 50 000 characters of
 * "[a" or "**a "; the cap keeps that in the low milliseconds).
 */
export const STRIP_MARKDOWN_MAX_INPUT = 4_000;

/** The first `max` UTF-16 units of `s`, never ending on half a surrogate pair. */
function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Markdown (a Strapi richtext body) as one line of plain text, for
 * previews such as the dashboard's LatestNews excerpts (UI03): they showed
 * the raw source, "**", "#" and link targets included. It removes the
 * syntax and keeps the words: link and image text (never their URLs),
 * heading, list, quote and table text, code without its backticks, and
 * backslash-escaped characters as themselves; raw HTML tags and comments
 * are dropped; all whitespace collapses to single spaces.
 *
 * Not a parser and not a sanitiser: the result is rendered as text (React
 * escapes it), never as HTML. Deliberately conservative where Markdown is
 * ambiguous: `snake_case`, "2 * 3" and a lone "<" stay as written. Reads
 * only the first `maxInput` characters ({@link STRIP_MARKDOWN_MAX_INPUT}).
 */
export function stripMarkdown(
  s?: string | null,
  { maxInput = STRIP_MARKDOWN_MAX_INPUT }: { maxInput?: number } = {},
): string {
  if (!s) return "";
  const held: string[] = [];
  const hold = (value: string) => `${HOLD_OPEN}${held.push(value) - 1}${HOLD_CLOSE}`;

  let text = cutAt(s, maxInput)
    .replace(/[\uE000\uE001]/g, "")
    .replace(/\r\n?/g, "\n")
    // Escaped punctuation is literal text: kept out of every rule below.
    .replace(/\\([!-/:-@[-`{-~])/g, (_, ch: string) => hold(ch))
    // Code fences: the fence lines go, the code stays.
    .replace(/^[ \t]*(?:```|~~~).*$/gm, "")
    // Code spans: the content, untouched by the rules below.
    .replace(/(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/g, (_, _ticks: string, code: string) =>
      hold(code.trim()),
    )
    // Reference definitions ("[id]: https://… 'title'") are not text.
    .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, "")
    // Images and links (inline and reference): their text, not the target
    // (one level of parentheses inside it, as in ".../Foo_(bar)").
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
    .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/g, "$1")
    // Autolinks: <https://…>, <mailto:…>, <name@host>.
    .replace(/<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/gi, "$1")
    // Raw HTML: comments and tags (not a lone "<" in prose).
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "")
    // Block markers at the start of a line; a heading also loses its
    // closing hashes ("## Title ##"), "#hashtag" is no heading.
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/gm, "$1")
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
    .replace(/^[ \t]*=+[ \t]*$/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    // Tables: the delimiter row goes, the cells stay.
    .replace(/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.*)$/gm, (_, row: string) => row.replace(/\|/g, " "))
    // Emphasis and strikethrough (not intraword underscores, not "2 * 3").
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, "$1$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");

  // A held code span can hold an escape held before it (lower index), so
  // restore until none is left; every pass resolves one level.
  const heldPiece = new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g");
  for (let pass = 0; pass < 3 && text.includes(HOLD_OPEN); pass++) {
    text = text.replace(heldPiece, (_, index: string) => held[Number(index)] ?? "");
  }
  return text.replace(/\s+/g, " ").trim();
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
