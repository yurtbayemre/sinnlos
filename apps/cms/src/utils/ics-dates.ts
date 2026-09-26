/**
 * Date lines of the event ICS export (datetime contract, deep-dive decision
 * 04, C7; the rest of the ICS builder is roadmap FX12).
 *
 *  - Timed events: DTSTART/DTEND in UTC with 'Z' (unchanged). Without an
 *    end, DTEND equals DTSTART.
 *  - All-day events: DTSTART;VALUE=DATE and an EXCLUSIVE DTEND;VALUE=DATE
 *    (RFC 5545 3.6.1). The days are the calendar days of start and end in
 *    APP_TIME_ZONE, the same days the web's month grid shows, so an all-day
 *    event entered as a local midnight is not exported as a timed event that
 *    starts at 22:00 or 23:00 UTC the day before.
 *  - DTSTAMP: the export time in UTC with 'Z'.
 */
import { comparePlainDates, toIsoZ, zonedDateOf, type InstantInput, type PlainDate } from "./time";

export interface IcsEventTimes {
  start: InstantInput;
  end?: InstantInput | null;
  allDay?: boolean | null;
}

/** 2026-10-01T10:00:00.000Z -> 20261001T100000Z */
function icsUtc(instant: InstantInput): string {
  return toIsoZ(instant).replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/** 2026-10-01 -> 20261001 */
function icsDate(date: PlainDate): string {
  return date.toString().replace(/-/g, "");
}

export function icsEventDateLines(event: IcsEventTimes, now: InstantInput, timeZone?: string): string[] {
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
