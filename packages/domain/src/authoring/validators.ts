import type { AuthoringFieldCode } from "./codes.js";
import { isIconKey } from "./icons.js";

/**
 * The value checks of v2 authoring (deep-dive decision 06 §B1.3; batch 15
 * plan, contract K7): one rule per kind of value for the cms allowlist
 * (apps/cms/src/utils/write-allowlist.ts), which is authoritative, and the
 * web forms, which run them first for precise messages.
 *
 * Every `check*` answers null when the value passes, or the field code
 * (codes.ts) it is refused with. The `is*` predicates are the same rules
 * as booleans. Pure; no time zone: the all-day midnight check needs
 * APP_TIME_ZONE and lives with the callers (plain-date.ts zonedDayStart).
 */

/** Strapi `string` attributes are varchar(255) on Postgres. */
export const MAX_STRING_LENGTH = 255;
/** Markdown bodies (announcement body, event description, ...). */
export const MAX_MARKDOWN_LENGTH = 200_000;
/** Ordering values (quick-link `order`). */
export const MIN_ORDER = 0;
export const MAX_ORDER = 10_000;
/** Strapi `integer` attributes are int4. */
export const MAX_INT32 = 2_147_483_647;
/** `publishAt` must lie at least this far ahead when it is saved (§D rule 3). */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

export type FieldCheck = (value: unknown) => AuthoringFieldCode | null;

const isString = (value: unknown): value is string => typeof value === "string";

// ---------------------------------------------------------------------------
// Predicates

/**
 * An ISO 8601 date-time with seconds optional, fractional seconds optional,
 * and `Z` or a numeric offset (`±hh:mm`), naming a real instant. The
 * datetime contract (DT-OFFSETLESS): an offset-less value would be read in
 * the server's zone.
 */
const OFFSET_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * False when `value` starts with a 'YYYY-MM-DD' that is no calendar day of
 * that year (#188): Date.parse rolls 2026-02-30 over into March 2, the cms's
 * Temporal parser refuses it. isOffsetInstant and plain-date.ts's
 * instantEpochMs check with it. Unlike isPlainDate's Date.UTC probe it keeps
 * the years 0000–0099 (Date.UTC reads them as 1900–1999), so an early-year
 * instant stays valid; isPlainDate keeps its own range. True for a value
 * without that prefix: the caller's own format check decides.
 */
export function startsWithRealDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return true;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function isOffsetInstant(value: unknown): value is string {
  return (
    isString(value) &&
    OFFSET_INSTANT.test(value) &&
    startsWithRealDay(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** The epoch milliseconds of an offset instant, or null. */
export function offsetInstantMs(value: unknown): number | null {
  return isOffsetInstant(value) ? Date.parse(value) : null;
}

/** C0 controls, DEL and a backslash: browsers rewrite them while parsing a URL. */
function hasUnsafeUrlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
}

/**
 * An absolute http(s) URL without credentials (`user:pass@`), at most
 * MAX_STRING_LENGTH characters, without control characters, spaces or a
 * backslash.
 */
export function isWebUrl(value: unknown): value is string {
  if (!isString(value) || value.length === 0 || value.length > MAX_STRING_LENGTH) return false;
  if (hasUnsafeUrlChar(value) || /\s/.test(value)) return false;
  let url: ParsedUrl;
  try {
    // The WHATWG parser (src/env.d.ts declares the slice the package
    // uses; username and password are part of every implementation).
    url = new URL(value) as unknown as ParsedUrl;
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * A same-origin absolute path (`/wiki/hr`): it starts with exactly one `/`,
 * never `//` (protocol-relative), and holds no control character, space or
 * backslash (the FX10 safeInternalPath rule of the web's sign-in
 * redirect), at most MAX_STRING_LENGTH characters.
 */
export function isInternalPath(value: unknown): value is string {
  if (!isString(value) || value.length > MAX_STRING_LENGTH) return false;
  if (hasUnsafeUrlChar(value) || /\s/.test(value)) return false;
  return value.startsWith("/") && !value.startsWith("//");
}

/** A quick link's target: an http(s) URL or an internal path. */
export function isQuickLinkUrl(value: unknown): value is string {
  return isWebUrl(value) || isInternalPath(value);
}

// ---------------------------------------------------------------------------
// Field checks

/** A required `string` attribute: non-blank, at most 255 characters. */
export const checkRequiredString: FieldCheck = (value) => {
  if (value === null || value === undefined) return "required";
  if (!isString(value)) return "invalid";
  if (value.trim() === "") return "required";
  return value.length > MAX_STRING_LENGTH ? "tooLong" : null;
};

/** An optional `string` attribute: null, or at most 255 characters. */
export const checkNullableString: FieldCheck = (value) => {
  if (value === null) return null;
  if (!isString(value)) return "invalid";
  return value.length > MAX_STRING_LENGTH ? "tooLong" : null;
};

/** Markdown (or long plain text): null, or at most 200 000 characters. */
export const checkMarkdown: FieldCheck = (value) => {
  if (value === null) return null;
  if (!isString(value)) return "invalid";
  return value.length > MAX_MARKDOWN_LENGTH ? "tooLong" : null;
};

/** A strict boolean (no "true", no 1). */
export const checkBoolean: FieldCheck = (value) => (typeof value === "boolean" ? null : "invalid");

/** A required instant with `Z` or an offset. */
export const checkInstant: FieldCheck = (value) => {
  if (value === null || value === undefined || value === "") return "required";
  return isOffsetInstant(value) ? null : "invalidInstant";
};

/** An optional instant with `Z` or an offset, or null. */
export const checkNullableInstant: FieldCheck = (value) =>
  value === null || isOffsetInstant(value) ? null : "invalidInstant";

/** One of `values` (an `enumeration` attribute). */
export function checkEnum(values: readonly string[]): FieldCheck {
  return (value) => (isString(value) && values.includes(value) ? null : "invalid");
}

/** An http(s) URL without credentials. */
export const checkWebUrl: FieldCheck = (value) => {
  if (value === null || value === undefined || value === "") return "required";
  return isWebUrl(value) ? null : "invalidUrl";
};

/** An http(s) URL without credentials, or null. */
export const checkNullableWebUrl: FieldCheck = (value) =>
  value === null || isWebUrl(value) ? null : "invalidUrl";

/** A quick link's target: an http(s) URL or an internal path. */
export const checkQuickLinkUrl: FieldCheck = (value) => {
  if (value === null || value === undefined || value === "") return "required";
  return isQuickLinkUrl(value) ? null : "invalidUrl";
};

/** An icon name of ICON_KEYS, or null. */
export const checkIconKey: FieldCheck = (value) =>
  value === null || isIconKey(value) ? null : "invalid";

/** An ordering value: an integer MIN_ORDER..MAX_ORDER. */
export const checkOrder: FieldCheck = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_ORDER && value <= MAX_ORDER
    ? null
    : "invalid";

/** A positive integer (int4), or null (an event's capacity). */
export const checkPositiveIntOrNull: FieldCheck = (value) =>
  value === null ||
  (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_INT32)
    ? null
    : "invalid";

// ---------------------------------------------------------------------------
// Cross-field checks (over the stored draft overlaid with the payload)

/** The instants a schedule check reads; unset and null mean "none". */
export interface ScheduleValues {
  publishAt?: unknown;
  unpublishAt?: unknown;
  expiresAt?: unknown;
}

/**
 * The refused keys of a schedule (§D rule 3), each with its code:
 *   - `publishAt` less than MIN_SCHEDULE_LEAD_MS after `now`: scheduleInPast
 *     (only when `publishAtChanged`: a stored schedule that is due now is
 *     the scheduler's, not a reason to refuse an unrelated save);
 *   - `unpublishAt` not after `publishAt`: unpublishBeforePublish;
 *   - `expiresAt` not after `publishAt`: expiresBeforePublish.
 * Values that are no instants are left to the field checks.
 */
export function scheduleCodes(
  merged: ScheduleValues,
  now: number,
  { publishAtChanged = true }: { publishAtChanged?: boolean } = {},
): Partial<Record<"publishAt" | "unpublishAt" | "expiresAt", AuthoringFieldCode>> {
  const codes: Partial<Record<"publishAt" | "unpublishAt" | "expiresAt", AuthoringFieldCode>> = {};
  const publishAt = offsetInstantMs(merged.publishAt);
  const unpublishAt = offsetInstantMs(merged.unpublishAt);
  const expiresAt = offsetInstantMs(merged.expiresAt);
  if (publishAt === null) return codes;
  if (publishAtChanged && publishAt < now + MIN_SCHEDULE_LEAD_MS)
    codes.publishAt = "scheduleInPast";
  if (unpublishAt !== null && unpublishAt <= publishAt)
    codes.unpublishAt = "unpublishBeforePublish";
  if (expiresAt !== null && expiresAt <= publishAt) codes.expiresAt = "expiresBeforePublish";
  return codes;
}

/** `end` before `start` (both instants): endBeforeStart on `end`. */
export function eventSpanCode(start: unknown, end: unknown): AuthoringFieldCode | null {
  const startMs = offsetInstantMs(start);
  const endMs = offsetInstantMs(end);
  return startMs !== null && endMs !== null && endMs < startMs ? "endBeforeStart" : null;
}
