import { describe, expect, it } from "vitest";

import { addDaysToKey, instantEpochMs, zonedDateKey, zonedWallTimeToInstant } from "./plain-date";
import { instantMsOrNull, parsePlainDate, wallTimeToInstant, zonedDateOf } from "./time";

/**
 * Parity between the two implementations of the datetime contract: time.ts
 * (Temporal) for server logic and plain-date.ts (Intl only) for code that
 * cannot load Temporal, such as the web's poll deadline and, later, client
 * components. Both must agree on one fixture table: instants around midnight
 * and DST changes, in zones with DST at 02:00/03:00 (Berlin), at midnight
 * (Santiago), by 30 minutes (Lord Howe), southern-hemisphere DST (Auckland)
 * and a non-hour offset (Kathmandu).
 */

const ZONES = [
  "Europe/Berlin",
  "America/New_York",
  "Pacific/Auckland",
  "America/Santiago",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
  "UTC",
];

const INSTANTS = [
  "2026-09-24T21:59:59.000Z",
  "2026-09-24T22:00:00.000Z",
  "2026-09-24T22:30:00.000Z",
  "2026-09-24T23:30:00.000Z",
  "2026-10-24T22:30:00.000Z",
  "2026-10-25T00:59:59.000Z",
  "2026-10-25T01:00:00.000Z",
  "2026-10-25T01:30:00.000Z",
  "2027-03-28T00:59:59.000Z",
  "2027-03-28T01:00:00.000Z",
  "2026-04-05T12:00:00.000Z",
  "2026-09-06T03:00:00.000Z",
  "2026-12-31T23:59:59.999Z",
  "2028-02-29T12:00:00.000Z",
];

const DATES = [
  "2026-09-30",
  "2026-10-24",
  "2026-10-25",
  "2026-10-26",
  "2027-03-27",
  "2027-03-28",
  "2026-04-05",
  "2026-09-05",
  "2026-09-06",
  "2026-10-04",
  "2026-11-01",
  "2027-03-14",
  "2028-02-29",
];

const WALL_TIMES = ["00:00", "00:30", "01:59:59", "02:00", "02:30", "03:00", "12:00", "23:59:59"];

/** Strings an instant parser meets: instants, and look-alikes that are none. */
const INSTANT_LIKE = [
  "2026-10-01T12:00Z",
  "2026-10-01T12:00:00Z",
  "2026-10-01T12:00:00.123Z",
  "2026-10-01T12:00:00+02:00",
  "2026-10-01T12:00:00-05:30",
  "2026-10-25T02:30:00+01:00",
  " 2026-10-01T12:00:00Z ",
  // No instants: a calendar date, offset-less date-times, garbage.
  "2026-10-01",
  "2026-10-01T12:00",
  "2026-10-01T12:00:00",
  "2026-10-01T12:00:00.000",
  "01.10.2026",
  "",
];
describe("time.ts and plain-date.ts agree", () => {
  it("on the calendar day of an instant (zonedDateOf vs zonedDateKey)", () => {
    for (const zone of ZONES) {
      for (const instant of INSTANTS) {
        expect(zonedDateKey(instant, zone), `${instant} ${zone}`).toBe(
          zonedDateOf(instant, zone).toString(),
        );
        expect(zonedDateKey(new Date(instant), zone), `${instant} ${zone} (Date)`).toBe(
          zonedDateOf(new Date(instant), zone).toString(),
        );
      }
    }
  });

  it("on what counts as an instant (instantEpochMs vs instantMsOrNull)", () => {
    for (const value of INSTANT_LIKE) {
      expect(instantEpochMs(value), JSON.stringify(value)).toBe(instantMsOrNull(value));
    }
    expect(instantEpochMs("2026-10-01")).toBeNull();
  });

  it("on calendar-day arithmetic (addDaysToKey vs PlainDate.add)", () => {
    for (const key of DATES) {
      for (const days of [-400, -31, -1, 0, 1, 7, 30, 90, 366]) {
        expect(addDaysToKey(key, days), `${key} ${days}`).toBe(
          parsePlainDate(key).add({ days }).toString(),
        );
      }
    }
  });

  it("on wall time to instant, including skipped and repeated times", () => {
    for (const zone of ZONES) {
      for (const key of DATES) {
        for (const time of WALL_TIMES) {
          expect(zonedWallTimeToInstant(key, time, zone).toISOString(), `${key} ${time} ${zone}`).toBe(
            wallTimeToInstant(parsePlainDate(key), time, zone).toISOString(),
          );
        }
      }
    }
  });
});
