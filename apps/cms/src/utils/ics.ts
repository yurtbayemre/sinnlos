/**
 * The ICS export of one event (GET /api/events/:id/ics, RFC 5545), built as a
 * pure function: no Strapi runtime, and the export time comes in as `now`.
 *
 * What the file carries, and why:
 *  - UID event-<documentId>@sinnlos. The documentId survives a re-publish
 *    (publish re-creates the published row with a new row id), so a calendar
 *    client updates the entry instead of importing it twice.
 *  - SEQUENCE and LAST-MODIFIED from the row's updatedAt. SEQUENCE counts the
 *    seconds since SEQUENCE_EPOCH, so it grows with every change and fits an
 *    RFC 5545 INTEGER until 2092; a client that compares it takes a newer
 *    export as a revision of the old one.
 *  - Dates (datetime contract, deep-dive decision 04, C7): timed events in
 *    UTC with 'Z', DTEND = DTSTART without an end; all-day events as
 *    DTSTART;VALUE=DATE plus an EXCLUSIVE DTEND;VALUE=DATE (RFC 5545 3.6.1),
 *    the calendar days of start and end in APP_TIME_ZONE, the days the web's
 *    month grid shows; DTSTAMP = the export time.
 *  - SUMMARY, LOCATION and DESCRIPTION as TEXT values (3.3.11): backslash,
 *    semicolon and comma escaped, every line break as the two characters
 *    backslash-n, other control characters dropped. DESCRIPTION is the
 *    richtext (Markdown) description as plain text.
 *  - URL only for http(s) links (a URI value has no escaping; control
 *    characters are dropped).
 *  - Every content line folded at 75 octets of UTF-8 (3.1), between code
 *    points, never inside a multi-byte character; lines end in CRLF.
 *  - Content-Disposition per RFC 6266: an ASCII `filename` fallback plus
 *    `filename*=UTF-8''<percent-encoded>`. A header value outside Latin-1
 *    (an en dash, a euro sign, an emoji in the title) made Node throw
 *    ERR_INVALID_CHAR, which Strapi answered with a 500 (FX12).
 */
import {
  appTimeZone,
  comparePlainDates,
  instantMsOrNull,
  toIsoZ,
  zonedDateOf,
  type InstantInput,
  type PlainDate,
} from "./time";

/** The event row fields the export reads (a db.query row of api::event.event). */
export interface IcsEvent {
  documentId: string;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  start: InstantInput;
  end?: InstantInput | null;
  allDay?: boolean | null;
  updatedAt?: InstantInput | null;
}

export interface IcsOptions {
  /** The business zone of all-day events; default APP_TIME_ZONE. */
  tz?: string;
  /** The export time (DTSTAMP); default the current time. */
  now?: InstantInput;
}

export interface IcsFile {
  contentType: string;
  contentDisposition: string;
  body: string;
}

export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

/** SEQUENCE = whole seconds of updatedAt since this instant (never negative). */
export const SEQUENCE_EPOCH = "2024-01-01T00:00:00Z";
const SEQUENCE_EPOCH_MS = Date.parse(SEQUENCE_EPOCH);
const MAX_SEQUENCE = 2147483647;

/** Octets per content line, CRLF excluded (RFC 5545 3.1). */
export const ICS_LINE_OCTETS = 75;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Lone surrogates become U+FFFD: UTF-8 cannot encode them, and
 * encodeURIComponent throws on them.
 */
function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, "\uFFFD");
}

/** 2026-10-01T10:00:00.000Z -> 20261001T100000Z */
function icsUtc(instant: InstantInput): string {
  return toIsoZ(instant).replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/** 2026-10-01 -> 20261001 */
function icsDate(date: PlainDate): string {
  return date.toString().replace(/-/g, "");
}

export interface IcsEventTimes {
  start: InstantInput;
  end?: InstantInput | null;
  allDay?: boolean | null;
}

/** DTSTAMP, DTSTART and DTEND (see the module header). */
export function icsEventDateLines(
  event: IcsEventTimes,
  now: InstantInput,
  timeZone?: string,
): string[] {
  const stamp = `DTSTAMP:${icsUtc(now)}`;
  const end = event.end == null || event.end === "" ? null : event.end;

  if (event.allDay === true) {
    const firstDay = zonedDateOf(event.start, timeZone);
    let lastDay = end === null ? firstDay : zonedDateOf(end, timeZone);
    if (comparePlainDates(lastDay, firstDay) < 0) lastDay = firstDay;
    return [
      stamp,
      `DTSTART;VALUE=DATE:${icsDate(firstDay)}`,
      `DTEND;VALUE=DATE:${icsDate(lastDay.add({ days: 1 }))}`,
    ];
  }

  const start = icsUtc(event.start);
  return [stamp, `DTSTART:${start}`, `DTEND:${end === null ? start : icsUtc(end)}`];
}

/** RFC 5545 TEXT: escape \ ; , and line breaks, drop other control characters. */
export function escapeIcsText(value: string): string {
  return wellFormed(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Folds one content line: at most 75 octets per physical line, continuation
 * lines start with a single space (which counts), and the split always falls
 * between two code points.
 */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  let limit = ICS_LINE_OCTETS;
  for (const char of wellFormed(line)) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
      limit = ICS_LINE_OCTETS - 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * The Markdown of a richtext field as plain text: headings, emphasis, code
 * and quote markers go, links keep their text and target, images their alt
 * text, HTML tags are dropped. Backslash escapes keep the escaped character.
 * Deliberately small: the result is a calendar note, not a renderer.
 */
export function markdownToPlainText(markdown: string): string {
  // Escaped characters are parked in the private use area (U+E000 + code)
  // so the emphasis rules below cannot see them; input already holding such
  // code points loses them.
  let text = wellFormed(markdown)
    .replace(/\r\n?/g, "\n")
    .replace(/[\uE000-\uE07F]/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|<])/g, (_m, c: string) =>
      String.fromCharCode(0xe000 + c.charCodeAt(0)),
    );
  text = text
    // Fenced code: keep the code, drop the fences.
    .replace(/^[ \t]*(```|~~~).*$/gm, "")
    // Images, then links, then autolinks.
    .replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, href: string) =>
      label === href ? href : `${label} (${href})`,
    )
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1")
    // HTML comments and tags (a <br> becomes a line break), then the
    // common entities.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    // Line markers: headings (ATX and setext), quotes, rules, bullets.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*$/gm, "")
    .replace(/^[ \t]{0,3}=+[ \t]*$/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ")
    // Inline code, strong, emphasis, strikethrough.
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
  return text
    .replace(/[\uE000-\uE07F]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** SEQUENCE for an updatedAt: grows with it, 0 without one. */
export function icsSequence(updatedAt: InstantInput | null | undefined): number {
  const ms = instantMsOrNull(updatedAt);
  if (ms === null || ms <= SEQUENCE_EPOCH_MS) return 0;
  return Math.min(Math.floor((ms - SEQUENCE_EPOCH_MS) / 1000), MAX_SEQUENCE);
}

// Characters the ASCII fallback spells out instead of replacing them with '_'.
const ASCII_FALLBACK: Record<string, string> = {
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  "€": "EUR",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "…": "...",
};
const DROPPED_QUOTES = /["“”„‟«»‹›]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** The file name without its extension: the trimmed title, or "event". */
function baseFileName(title: string | null | undefined): string {
  const name = wellFormed(typeof title === "string" ? title : "")
    .replace(CONTROL_CHARS, "")
    .replace(/[\\/]/g, "-")
    .trim();
  return name === "" ? "event" : name;
}

/** Printable ASCII for the `filename` parameter (quotes and backslashes removed). */
function asciiFileName(name: string): string {
  const ascii = name
    .replace(/[ÄÖÜäöüß€‐‑‒–—―−‘’‚…]/g, (c) => ASCII_FALLBACK[c] ?? c)
    .replace(DROPPED_QUOTES, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^\x20-\x7E]/gu, "_")
    .replace(/["\\]/g, "")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[_ ]+|[_ ]+$/g, "");
  return ascii === "" || /^[_ .]+$/.test(ascii) ? "event" : ascii;
}

/** RFC 8187 value-chars: percent-encode everything but attr-char. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Content-Disposition for the export of an event titled `title`. */
export function icsContentDisposition(title: string | null | undefined): string {
  const name = baseFileName(title);
  return `attachment; filename="${asciiFileName(name)}.ics"; filename*=UTF-8''${encodeRfc8187(`${name}.ics`)}`;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function httpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const url = wellFormed(value).replace(CONTROL_CHARS, "").trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/** The complete ICS file for one published event row. */
export function buildIcs(event: IcsEvent, options: IcsOptions = {}): IcsFile {
  const timeZone = options.tz ?? appTimeZone();
  const now = options.now ?? new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sinnlos//Events//EN",
    "BEGIN:VEVENT",
    `UID:event-${event.documentId}@sinnlos`,
    ...icsEventDateLines(event, now, timeZone),
    `SEQUENCE:${icsSequence(event.updatedAt)}`,
  ];
  if (instantMsOrNull(event.updatedAt) !== null) {
    lines.push(`LAST-MODIFIED:${icsUtc(event.updatedAt as InstantInput)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(event.title ?? "")}`);
  const location = nonEmpty(event.location);
  if (location !== null) lines.push(`LOCATION:${escapeIcsText(location)}`);
  const description = nonEmpty(event.description);
  const plain = description === null ? "" : markdownToPlainText(description);
  if (plain !== "") lines.push(`DESCRIPTION:${escapeIcsText(plain)}`);
  const url = httpUrl(event.url);
  if (url !== null) lines.push(`URL:${url}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return {
    contentType: ICS_CONTENT_TYPE,
    contentDisposition: icsContentDisposition(event.title),
    body: `${lines.map(foldIcsLine).join("\r\n")}\r\n`,
  };
}
