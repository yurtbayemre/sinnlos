/**
 * Dates and times of the /manage forms (deep-dive decision 06 §L4; batch 15
 * plan, lane 15C item 6). Pure; every zone is explicit, normally
 * APP_TIME_ZONE, which the page hands to the form and the action reads
 * itself.
 *
 *  - An instant field (an event's start, expiresAt, publishAt, …) is a
 *    date input plus a time input. The action converts them with
 *    zonedWallTimeToInstant(day, time, zone, "reject"): a wall time that a
 *    clock change repeats or skips is refused with the field code
 *    timeRepeated or timeSkipped, never guessed. The browser's zone is
 *    never involved (no `new Date(value)` on a typed string).
 *  - An all-day event's days are sent as zonedDayStart(day): local
 *    midnights, the end at the midnight of its last day (inclusive), which
 *    the cms requires (notMidnight).
 *  - A form shows a stored instant as zonedDateKey plus zonedTimeOfDay
 *    (HH:mm) in the same zone.
 */
import {
  isPlainDate,
  isWallTimeError,
  zonedDateKey,
  zonedDayStart,
  zonedTimeOfDay,
  zonedWallTimeToInstant,
} from "@/lib/plain-date";
import type { ManageErrorCode } from "./errors";

/** A converted field: its payload value, or the code it is refused with. */
export type Converted<T> = { value: T } | { code: ManageErrorCode };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for an 'HH:mm' value of an <input type="time">. */
export function isWallTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

/**
 * An optional instant from a date and a time input (ISO-Z), in reject
 * mode. Both empty: null. A date without a time, or a time without a date
 * and no `fallbackDate`: required. A malformed date: invalidDate; a
 * malformed time: invalidInstant.
 */
export function wallTimeInstant(
  date: string,
  time: string,
  timeZone: string,
  { fallbackDate }: { fallbackDate?: string } = {},
): Converted<string | null> {
  const clock = time.trim();
  const day = date.trim() || (clock ? (fallbackDate?.trim() ?? "") : "");
  if (day === "" && clock === "") return { value: null };
  if (day === "" || clock === "") return { code: "required" };
  if (!isPlainDate(day)) return { code: "invalidDate" };
  if (!isWallTime(clock)) return { code: "invalidInstant" };
  try {
    return { value: zonedWallTimeToInstant(day, clock, timeZone, "reject").toISOString() };
  } catch (error) {
    if (isWallTimeError(error)) {
      return { code: error.kind === "repeated" ? "timeRepeated" : "timeSkipped" };
    }
    return { code: "invalidInstant" };
  }
}

/** A required instant from a date and a time input (both empty: required). */
export function requiredWallTimeInstant(
  date: string,
  time: string,
  timeZone: string,
): Converted<string> {
  const converted = wallTimeInstant(date, time, timeZone);
  if ("code" in converted) return converted;
  return converted.value === null ? { code: "required" } : { value: converted.value };
}

/**
 * The first instant of a calendar day (an all-day event's start or end),
 * ISO-Z; an empty day is null, or required when `required`.
 */
export function dayStartInstant(
  day: string,
  timeZone: string,
  { required = false }: { required?: boolean } = {},
): Converted<string | null> {
  const key = day.trim();
  if (key === "") return required ? { code: "required" } : { value: null };
  if (!isPlainDate(key)) return { code: "invalidDate" };
  return { value: zonedDayStart(key, timeZone).toISOString() };
}

/** An optional calendar date (`YYYY-MM-DD`, e.g. ackDeadline); empty is null. */
export function plainDateValue(day: string): Converted<string | null> {
  const key = day.trim();
  if (key === "") return { value: null };
  return isPlainDate(key) ? { value: key } : { code: "invalidDate" };
}

/** The date and time inputs of a stored instant; empty for none (or no instant). */
export function splitInstant(
  instant: string | null | undefined,
  timeZone: string,
): { date: string; time: string } {
  if (!instant) return { date: "", time: "" };
  try {
    return { date: zonedDateKey(instant, timeZone), time: zonedTimeOfDay(instant, timeZone) };
  } catch {
    return { date: "", time: "" };
  }
}

/** The calendar day of a stored instant in the zone (an all-day event's day); "" for none. */
export function instantDay(instant: string | null | undefined, timeZone: string): string {
  return splitInstant(instant, timeZone).date;
}
