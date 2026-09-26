/**
 * Calendar dates and zone lookups with Intl only (datetime contract,
 * deep-dive decision 04, C5). No imports and no process access, so the file
 * runs anywhere: cms, web server code and web client components.
 *
 * MIRRORED: apps/cms/src/utils/plain-date.ts and apps/web/src/lib/plain-date.ts
 * are byte-identical (plain-date-mirror.test.ts). Change both together.
 *
 * Two value classes, never mixed:
 *  - a calendar date is the string 'YYYY-MM-DD' (Postgres `date`); it has no
 *    zone and is never turned into a midnight instant for logic;
 *  - an instant is a Date, or an ISO-8601 string with 'Z' or a numeric offset.
 * Every zone is explicit (an IANA name, normally APP_TIME_ZONE); the process
 * zone is never used.
 */

const PLAIN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
/** An ISO date-time must end in Z or a numeric offset to be an instant. */
const INSTANT_SUFFIX_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

const DAY_MS = 86400000;

/** True for 'YYYY-MM-DD' naming a real calendar day (no 2026-02-31). */
export function isPlainDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = PLAIN_DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** True when Intl knows the IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  return canonicalTimeZone(timeZone) !== null;
}

/** Intl's canonical spelling of a zone name ('europe/berlin' -> 'Europe/Berlin'), or null. */
export function canonicalTimeZone(timeZone: string): string | null {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timeZone.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The business zone when APP_TIME_ZONE is unset. */
export const DEFAULT_APP_TIME_ZONE = "Europe/Berlin";

/**
 * Validates an APP_TIME_ZONE value (the raw env string). Unset means the
 * default; an empty or unknown name throws, so a typo fails the start
 * instead of silently moving every business day. Returns the canonical name.
 */
export function resolveAppTimeZone(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_APP_TIME_ZONE;
  const canonical = canonicalTimeZone(raw);
  if (!canonical) {
    throw new Error(
      `APP_TIME_ZONE must be an IANA time zone name such as "Europe/Berlin" (got "${raw}"). ` +
        "Leave it unset for the default Europe/Berlin.",
    );
  }
  return canonical;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One cached numeric formatter per zone (Intl construction is not free). */
function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(epochMs: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Some engines print midnight as 24 even with h23.
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** The zone's UTC offset in ms at the given instant (whole seconds). */
function offsetMsAt(epochMs: number, timeZone: string): number {
  const wall = wallClockAt(epochMs, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

function toEpochMs(instant: Date | string): number {
  if (instant instanceof Date) {
    const ms = instant.getTime();
    if (Number.isNaN(ms)) throw new RangeError("Invalid Date");
    return ms;
  }
  if (typeof instant !== "string" || !INSTANT_SUFFIX_RE.test(instant.trim())) {
    throw new RangeError(`Not an instant (ISO-8601 with Z or an offset): ${String(instant)}`);
  }
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`Not an instant: ${instant}`);
  return ms;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The calendar day ('YYYY-MM-DD') an instant falls on in the given zone. */
export function zonedDateKey(instant: Date | string, timeZone: string): string {
  const wall = wallClockAt(toEpochMs(instant), timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Calendar-day arithmetic on 'YYYY-MM-DD' keys (UTC-based, no DST involved). */
export function addDaysToKey(key: string, days: number): string {
  if (!isPlainDate(key)) throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${key}`);
  if (!Number.isInteger(days)) throw new RangeError(`Not a whole number of days: ${days}`);
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * Human-readable calendar date. Formats in UTC on purpose: the key is a day,
 * not an instant, so no zone may move it (30 Sep stays 30 Sep everywhere).
 */
export function formatPlainDate(
  locale: string,
  key: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  if (!isPlainDate(key)) throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${key}`);
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/**
 * The instant at which the wall clock in `timeZone` shows `time` ('HH:mm' or
 * 'HH:mm:ss') on calendar day `key`. DST is resolved like Temporal's
 * 'compatible' disambiguation: a repeated wall time (fall back) gives the
 * earlier instant, a skipped one (spring forward) moves forward by the gap.
 * Mirrors time.ts wallTimeToInstant() for Intl-only callers (time-parity.test.ts).
 */
export function zonedWallTimeToInstant(key: string, time: string, timeZone: string): Date {
  if (!isPlainDate(key)) throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${key}`);
  const clock = WALL_TIME_RE.exec(time);
  if (!clock) throw new RangeError(`Not a wall time (HH:mm or HH:mm:ss): ${time}`);
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Unknown time zone: ${timeZone}`);
  const [year, month, day] = key.split("-").map(Number);
  const wallAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    Number(clock[1]),
    Number(clock[2]),
    clock[3] === undefined ? 0 : Number(clock[3]),
  );
  // A zone changes its offset at most once within two days, so the offsets a
  // day before and a day after are the only two candidates.
  const offsetBefore = offsetMsAt(wallAsUtc - DAY_MS, timeZone);
  const offsetAfter = offsetMsAt(wallAsUtc + DAY_MS, timeZone);
  const candidates = [wallAsUtc - offsetBefore, wallAsUtc - offsetAfter].filter(
    (candidate) => candidate + offsetMsAt(candidate, timeZone) === wallAsUtc,
  );
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // The wall time does not exist (spring forward): shift it by the gap.
  return new Date(wallAsUtc - offsetBefore);
}
