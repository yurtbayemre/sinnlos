/**
 * The cms time module (datetime contract, deep-dive decision 04, C5).
 *
 * All calendar math of the cms goes through here, on Temporal
 * (temporal-polyfill, pinned exactly in package.json and imported only in this
 * file; ESLint enforces both). Native Temporal can replace the polyfill later
 * without touching a caller.
 *
 * Rules:
 *  - An instant is a point on the timeline: a Date, a Temporal.Instant, or an
 *    ISO-8601 string with 'Z' or a numeric offset. An offset-less string is
 *    rejected (toInstant throws), because its meaning would depend on a zone.
 *  - A calendar date is a Temporal.PlainDate in code and 'YYYY-MM-DD' on the
 *    wire and in Postgres `date` columns. It is never a midnight instant.
 *  - The business zone is APP_TIME_ZONE (default Europe/Berlin, one value per
 *    deployment). The process zone (TZ, UTC in the container) is never used:
 *    "today", day and week windows, anniversaries and cron times all take the
 *    zone explicitly, defaulting to appTimeZone().
 */
import { Temporal } from "temporal-polyfill";

import { DEFAULT_APP_TIME_ZONE, isPlainDate, resolveAppTimeZone } from "./plain-date";

export type PlainDate = Temporal.PlainDate;
export type Instant = Temporal.Instant;
export type InstantInput = Date | string | Temporal.Instant;
export type Disambiguation = "compatible" | "earlier" | "later" | "reject";

// One implementation for cms and web (plain-date.ts is mirrored).
export { DEFAULT_APP_TIME_ZONE, resolveAppTimeZone };

const WALL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

let cachedZone: { raw: string | undefined; zone: string } | null = null;

/** APP_TIME_ZONE from the environment, validated (see resolveAppTimeZone). */
export function appTimeZone(env: Record<string, string | undefined> = process.env): string {
  const raw = env.APP_TIME_ZONE;
  if (cachedZone && cachedZone.raw === raw) return cachedZone.zone;
  const zone = resolveAppTimeZone(raw);
  cachedZone = { raw, zone };
  return zone;
}

/** Names that denote UTC itself (what TZ=UTC resolves to on every platform). */
const UTC_ZONE_NAMES = new Set([
  "UTC",
  "Etc/UTC",
  "Etc/UCT",
  "UCT",
  "Etc/Universal",
  "Universal",
  "Etc/Zulu",
  "Zulu",
  "Etc/GMT",
  "GMT",
  "Etc/GMT0",
  "GMT0",
  "Etc/GMT+0",
  "Etc/GMT-0",
  "GMT+0",
  "GMT-0",
  "Etc/Greenwich",
  "Greenwich",
]);

/** True for a zone name that means UTC (not merely offset 0, like Europe/London in winter). */
export function isUtcZone(timeZone: string | undefined | null): boolean {
  return typeof timeZone === "string" && UTC_ZONE_NAMES.has(timeZone.trim());
}

/** The zone this process formats local Date fields in (from TZ). */
export function processTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

/** Parses an instant; throws on invalid Dates and on strings without Z/offset. */
export function toInstant(value: InstantInput): Temporal.Instant {
  if (value instanceof Temporal.Instant) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new RangeError("Invalid Date");
    return Temporal.Instant.fromEpochMilliseconds(ms);
  }
  if (typeof value !== "string") {
    throw new TypeError(`Not an instant: ${String(value)}`);
  }
  // Temporal rejects offset-less date-times on its own; the message names the rule.
  try {
    return Temporal.Instant.from(value.trim());
  } catch {
    throw new RangeError(`Not an instant (ISO-8601 with Z or a numeric offset required): "${value}"`);
  }
}

/** Epoch milliseconds of a valid instant, or null (null/''/garbage/offset-less). */
export function instantMsOrNull(value: InstantInput | null | undefined): number | null {
  if (value == null || value === "") return null;
  try {
    return toInstant(value).epochMilliseconds;
  } catch {
    return null;
  }
}

/** ISO-8601 in UTC with milliseconds and 'Z' (the wire format of every instant). */
export function toIsoZ(value: InstantInput): string {
  return toInstant(value).toString({ fractionalSecondDigits: 3 });
}

/** A Date for an instant (for Strapi queries and knex bindings). */
export function toDate(value: InstantInput): Date {
  return new Date(toInstant(value).epochMilliseconds);
}

/** The current instant. */
export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** Today's calendar date in the zone (default APP_TIME_ZONE). */
export function todayIn(
  timeZone: string = appTimeZone(),
  now: InstantInput = Temporal.Now.instant(),
): Temporal.PlainDate {
  return toInstant(now).toZonedDateTimeISO(timeZone).toPlainDate();
}

/** The calendar date an instant falls on in the zone. */
export function zonedDateOf(instant: InstantInput, timeZone: string = appTimeZone()): Temporal.PlainDate {
  return toInstant(instant).toZonedDateTimeISO(timeZone).toPlainDate();
}

/** The wall-clock hour (0-23) of an instant in the zone. */
export function zonedHourOf(instant: InstantInput, timeZone: string = appTimeZone()): number {
  return toInstant(instant).toZonedDateTimeISO(timeZone).hour;
}

/** The zone's UTC offset in minutes at an instant (e.g. 120 for CEST). */
export function offsetMinutesAt(instant: InstantInput, timeZone: string): number {
  return toInstant(instant).toZonedDateTimeISO(timeZone).offsetNanoseconds / 60e9;
}

/** Strict 'YYYY-MM-DD' parser; throws on other shapes and on impossible days. */
export function parsePlainDate(value: string): Temporal.PlainDate {
  if (!isPlainDate(value)) {
    throw new RangeError(`Not a calendar date (YYYY-MM-DD): "${value}"`);
  }
  return Temporal.PlainDate.from(value, { overflow: "reject" });
}

/** parsePlainDate for untrusted input: null instead of an exception. */
export function tryParsePlainDate(value: unknown): Temporal.PlainDate | null {
  if (!isPlainDate(value)) return null;
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    return null;
  }
}

/** Temporal.PlainDate.compare: negative, 0 or positive. */
export function comparePlainDates(a: Temporal.PlainDate, b: Temporal.PlainDate): number {
  return Temporal.PlainDate.compare(a, b);
}

/**
 * First instant of a calendar day in the zone. ZonedDateTime semantics, so a
 * day that starts inside a DST gap starts at the first valid instant. Day
 * windows are half-open: [startOfDayInstant(D), startOfDayInstant(D + 1)).
 */
export function startOfDayInstant(date: Temporal.PlainDate, timeZone: string = appTimeZone()): Date {
  return new Date(date.toZonedDateTime({ timeZone }).epochMilliseconds);
}

/** The Monday of the ISO week containing the date. */
export function startOfIsoWeek(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 });
}

/** The days of a month view: whole Monday-to-Sunday weeks covering the month. */
export function monthGrid(year: number, month: number): Temporal.PlainDate[] {
  const first = Temporal.PlainDate.from({ year, month, day: 1 }, { overflow: "reject" });
  const last = first.with({ day: first.daysInMonth });
  const start = startOfIsoWeek(first);
  const end = last.add({ days: 7 - last.dayOfWeek });
  const days: Temporal.PlainDate[] = [];
  for (let day = start; Temporal.PlainDate.compare(day, end) <= 0; day = day.add({ days: 1 })) {
    days.push(day);
  }
  return days;
}

/**
 * The instant at which the zone's wall clock shows `time` ('HH:mm' or
 * 'HH:mm:ss') on `date`. 'compatible' (the default) takes the earlier instant
 * of a repeated wall time and moves a skipped one forward by the gap; a form
 * that lets a user type a time of day passes 'reject' and shows the error.
 */
export function wallTimeToInstant(
  date: Temporal.PlainDate,
  time: string,
  timeZone: string = appTimeZone(),
  disambiguation: Disambiguation = "compatible",
): Date {
  const clock = WALL_TIME_RE.exec(time);
  if (!clock) throw new RangeError(`Not a wall time (HH:mm or HH:mm:ss): "${time}"`);
  const zoned = date
    .toPlainDateTime({
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: clock[3] === undefined ? 0 : Number(clock[3]),
    })
    .toZonedDateTime(timeZone, { disambiguation });
  return new Date(zoned.epochMilliseconds);
}

/** The same wall time `days` calendar days later in the zone (DST-safe). */
export function addCalendarDays(instant: InstantInput, days: number, timeZone: string = appTimeZone()): Date {
  return new Date(toInstant(instant).toZonedDateTimeISO(timeZone).add({ days }).epochMilliseconds);
}

export interface AnnualOccurrence {
  /** The next occurrence on or after `from`. */
  next: Temporal.PlainDate;
  /** Whole days from `from` to `next` (0 = today). */
  daysUntil: number;
  /** Completed years at `next` (e.g. an anniversary's jubilee count). */
  years: number;
}

/**
 * Next yearly occurrence of a date's month/day on or after `from`.
 * Policy: Feb 29 falls on Feb 28 in non-leap years (Temporal overflow
 * 'constrain'; BGB §188(3) also ends a period on the month's last day).
 * Callers skip anniversaries with years < 1 (same-day or future hire dates).
 */
export function nextAnnual(date: Temporal.PlainDate, from: Temporal.PlainDate): AnnualOccurrence {
  let next = date.with({ year: from.year }, { overflow: "constrain" });
  if (Temporal.PlainDate.compare(next, from) < 0) {
    next = date.with({ year: from.year + 1 }, { overflow: "constrain" });
  }
  return {
    next,
    daysUntil: from.until(next, { largestUnit: "days" }).days,
    years: next.year - date.year,
  };
}

/** Human-readable instant in the zone, for cms-side text (digests, logs). */
export function formatInstant(
  locale: string,
  instant: InstantInput,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
  timeZone: string = appTimeZone(),
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(toDate(instant));
}
