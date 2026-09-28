/**
 * Dates of the /events list (datetime contract, decision 04, phase 2, and
 * FX49). Pure: the page passes next-intl's formatter, whose zone is
 * APP_TIME_ZONE (i18n/request.ts), and the same zone for the calendar-day
 * comparisons, so nothing depends on the process zone.
 */
import type { DateTimeFields, DateTimeFormatter } from "@/lib/date-format";
import { instantEpochMs, zonedDateKey } from "@/lib/plain-date";
import type { Event } from "@/lib/types";

const DAY_FORMAT: DateTimeFields = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
};
const DAY_TIME_FORMAT: DateTimeFields = {
  ...DAY_FORMAT,
  hour: "2-digit",
  minute: "2-digit",
};
const TIME_FORMAT: DateTimeFields = { hour: "2-digit", minute: "2-digit" };

/**
 * The time line of an event card. An all-day event shows its day, a timed
 * one its start with the time. An end on the same calendar day adds only its
 * time ("– 17:00"); an end on a later day adds that day as well, so a
 * multi-day event no longer reads like a one-day one (FX49: a three-day
 * offsite used to show "Mon, Oct 5, 2026, 09:00 – 17:00"). An end that is no
 * instant, or not after the start, is left out. "" for a start that is no
 * instant.
 */
export function eventTimeLabel(
  event: Pick<Event, "start" | "end" | "allDay">,
  format: DateTimeFormatter,
  timeZone: string,
): string {
  const startMs = instantEpochMs(event.start);
  if (startMs === null) return "";
  const start = new Date(startMs);
  const endMs = event.end ? instantEpochMs(event.end) : null;
  const end = endMs !== null && endMs > startMs ? new Date(endMs) : null;
  const sameDay = end !== null && zonedDateKey(end, timeZone) === zonedDateKey(start, timeZone);
  if (event.allDay) {
    const first = format.dateTime(start, DAY_FORMAT);
    return end && !sameDay ? `${first} – ${format.dateTime(end, DAY_FORMAT)}` : first;
  }
  const first = format.dateTime(start, DAY_TIME_FORMAT);
  if (!end) return first;
  return `${first} – ${format.dateTime(end, sameDay ? TIME_FORMAT : DAY_TIME_FORMAT)}`;
}

/**
 * The date badge of an event card: the short month name and the day number
 * of its start in `timeZone`. null for a start that is no instant.
 */
export function eventBadge(
  event: Pick<Event, "start">,
  format: DateTimeFormatter,
  timeZone: string,
): { month: string; day: number } | null {
  const startMs = instantEpochMs(event.start);
  if (startMs === null) return null;
  const start = new Date(startMs);
  return {
    month: format.dateTime(start, { month: "short" }),
    // The key's day, not a formatted one: de formats { day: "numeric" } as "5.".
    day: Number(zonedDateKey(start, timeZone).slice(8, 10)),
  };
}
