import { describe, expect, it } from "vitest";

import {
  addDaysToKey,
  daysBetweenKeys,
  isoWeekdayOfKey,
  zonedDateKey,
  zonedDayStart,
  zonedHour,
} from "./plain-date";

/**
 * The calendar helpers the web's datetime port (phase 2) added to the
 * mirrored plain-date.ts. Fixed instants and zones only, so the results do
 * not depend on the process zone (`pnpm test:tz` runs this file under UTC,
 * Europe/Berlin and Pacific/Auckland). The expected values are what
 * Temporal gives (startOfDay, hour, dayOfWeek, until): checked once against
 * the cms time.ts, which the Intl-only helpers must match.
 */
describe("zonedDayStart: the first instant of a calendar day in a zone", () => {
  it.each([
    // [day, zone, first instant]
    ["2026-09-30", "Europe/Berlin", "2026-09-29T22:00:00.000Z"],
    ["2026-10-25", "Europe/Berlin", "2026-10-24T22:00:00.000Z"], // 25-hour day (fall back)
    ["2026-10-26", "Europe/Berlin", "2026-10-25T23:00:00.000Z"],
    ["2027-03-28", "Europe/Berlin", "2027-03-27T23:00:00.000Z"], // 23-hour day (spring forward)
    ["2027-03-29", "Europe/Berlin", "2027-03-28T22:00:00.000Z"],
    ["2026-11-01", "America/New_York", "2026-11-01T04:00:00.000Z"],
    ["2026-11-02", "America/New_York", "2026-11-02T05:00:00.000Z"],
    // Chile skips midnight: the day starts at 01:00 (-03).
    ["2026-09-06", "America/Santiago", "2026-09-06T04:00:00.000Z"],
    ["2026-09-30", "Asia/Kathmandu", "2026-09-29T18:15:00.000Z"],
    ["2026-09-30", "UTC", "2026-09-30T00:00:00.000Z"],
  ])("%s in %s starts at %s", (day, zone, expected) => {
    const start = zonedDayStart(day, zone);
    expect(start.toISOString()).toBe(expected);
    // It lies on that day, and one millisecond earlier is the day before.
    expect(zonedDateKey(start, zone)).toBe(day);
    expect(zonedDateKey(new Date(start.getTime() - 1), zone)).toBe(addDaysToKey(day, -1));
  });

  it("gives half-open day windows of 23, 24 and 25 hours around the Berlin DST changes", () => {
    const hours = (day: string) =>
      (zonedDayStart(addDaysToKey(day, 1), "Europe/Berlin").getTime() -
        zonedDayStart(day, "Europe/Berlin").getTime()) /
      3_600_000;
    expect(hours("2026-10-24")).toBe(24);
    expect(hours("2026-10-25")).toBe(25);
    expect(hours("2027-03-28")).toBe(23);
  });

  it("refuses a value that is no calendar date or an unknown zone", () => {
    expect(() => zonedDayStart("2026-02-30", "Europe/Berlin")).toThrow(/calendar date/);
    expect(() => zonedDayStart("2026-09-30", "Mars/Olympus")).toThrow(/time zone/);
  });
});

describe("zonedHour: the wall-clock hour of an instant in a zone", () => {
  it.each([
    ["2026-09-30T22:30:00.000Z", "Europe/Berlin", 0], // already Oct 1, 00:30
    ["2026-09-30T21:59:59.999Z", "Europe/Berlin", 23],
    ["2026-10-25T00:30:00.000Z", "Europe/Berlin", 2], // 02:30 CEST
    ["2026-10-25T01:30:00.000Z", "Europe/Berlin", 2], // 02:30 CET, the repeated hour
    ["2027-03-28T01:00:00.000Z", "Europe/Berlin", 3], // 02:00 is skipped
    ["2026-09-30T10:00:00.000Z", "America/New_York", 6],
    ["2026-09-30T10:00:00.000Z", "UTC", 10],
    ["2026-09-30T10:00:00+02:00", "UTC", 8],
  ])("%s in %s is hour %i", (instant, zone, hour) => {
    expect(zonedHour(instant, zone)).toBe(hour);
    expect(zonedHour(new Date(instant), zone)).toBe(hour);
  });

  it("refuses an offset-less date-time", () => {
    expect(() => zonedHour("2026-09-30T10:00:00", "Europe/Berlin")).toThrow(/instant/);
  });
});

describe("isoWeekdayOfKey and daysBetweenKeys", () => {
  it("names Monday 1 and Sunday 7", () => {
    expect(isoWeekdayOfKey("2026-06-01")).toBe(1);
    expect(isoWeekdayOfKey("2026-09-01")).toBe(2);
    expect(isoWeekdayOfKey("2026-02-01")).toBe(7);
    expect(isoWeekdayOfKey("2027-02-01")).toBe(1);
    expect(isoWeekdayOfKey("2028-02-29")).toBe(2);
  });

  it("counts calendar days, not 24-hour steps, across DST, months and years", () => {
    expect(daysBetweenKeys("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetweenKeys("2027-03-27", "2027-03-29")).toBe(2);
    expect(daysBetweenKeys("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetweenKeys("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetweenKeys("2027-02-28", "2027-03-01")).toBe(1);
    expect(daysBetweenKeys("2026-09-30", "2026-09-30")).toBe(0);
    expect(daysBetweenKeys("2026-10-01", "2026-09-30")).toBe(-1);
    expect(daysBetweenKeys("2026-01-01", "2027-01-01")).toBe(365);
  });

  it("refuses values that are no calendar dates", () => {
    expect(() => isoWeekdayOfKey("2026-9-1")).toThrow(/calendar date/);
    expect(() => daysBetweenKeys("2026-09-30", "2026-09-31")).toThrow(/calendar date/);
  });
});
