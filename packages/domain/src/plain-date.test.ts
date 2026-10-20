import { describe, expect, it } from "vitest";

import {
  addDaysToKey,
  addMonthsToKey,
  canonicalTimeZone,
  daysBetweenKeys,
  formatPlainDate,
  instantEpochMs,
  isPlainDate,
  isValidTimeZone,
  isWallTimeError,
  isoWeekdayOfKey,
  resolveAppTimeZone,
  WallTimeError,
  zonedDateKey,
  zonedDayStart,
  zonedHour,
  zonedTimeOfDay,
  zonedWallTimeToInstant,
} from "./plain-date.js";

/**
 * The Intl-only calendar helpers of both apps (datetime contract, decision
 * 04, C5). The cms's Temporal module must agree with them
 * (apps/cms/src/utils/time-parity.test.ts).
 */

describe("plain-date", () => {
  it("isPlainDate accepts real days in YYYY-MM-DD only", () => {
    expect(isPlainDate("2026-09-30")).toBe(true);
    expect(isPlainDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2027-02-29",
      "2026-02-31",
      "2026-13-01",
      "2026-00-10",
      "2026-9-30",
      "",
      null,
      20260930,
    ]) {
      expect(isPlainDate(bad), String(bad)).toBe(false);
    }
  });

  it("zone names are validated and canonicalised by Intl", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
    expect(canonicalTimeZone("US/Eastern")).toBe("America/New_York");
    // Offsets are no zones: Intl takes '+02:00' as UTC+2, Postgres as UTC-2.
    for (const offset of ["+02:00", "+0200", "-05", "\u221202:00", " +02:00"]) {
      expect(canonicalTimeZone(offset), offset).toBeNull();
    }
    expect(canonicalTimeZone("Etc/GMT-2")).toBe("Etc/GMT-2");
  });

  it("resolveAppTimeZone returns the canonical name and refuses offsets", () => {
    expect(resolveAppTimeZone(undefined)).toBe("Europe/Berlin");
    expect(resolveAppTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(() => resolveAppTimeZone("+02:00")).toThrow(/APP_TIME_ZONE .*not a UTC offset/);
    expect(() => resolveAppTimeZone("")).toThrow(/APP_TIME_ZONE/);
  });

  it("zonedDateKey requires a real instant", () => {
    expect(() => zonedDateKey("2026-09-24T10:00:00", "Europe/Berlin")).toThrow(/instant/);
    expect(() => zonedDateKey(new Date(Number.NaN), "Europe/Berlin")).toThrow();
    expect(zonedDateKey("2026-09-24T23:30:00+02:00", "Europe/Berlin")).toBe("2026-09-24");
  });

  it("a calendar date is no instant: its '-DD' is not an offset", () => {
    // Date.parse would read it as UTC midnight (the previous suffix check let it through).
    expect(() => zonedDateKey("2026-10-01", "Europe/Berlin")).toThrow(/instant/);
    expect(instantEpochMs("2026-10-01")).toBeNull();
    expect(instantEpochMs("2026-10-01T00:00Z")).toBe(Date.UTC(2026, 9, 1));
    expect(instantEpochMs(" 2026-10-01T02:00:00+02:00 ")).toBe(Date.UTC(2026, 9, 1));
    expect(instantEpochMs(new Date(Number.NaN))).toBeNull();
  });

  it("addDaysToKey crosses month, year and leap-day boundaries", () => {
    expect(addDaysToKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToKey("2027-03-01", -1)).toBe("2027-02-28");
    expect(() => addDaysToKey("2026-02-31", 1)).toThrow();
    expect(() => addDaysToKey("2026-09-30", 0.5)).toThrow();
  });

  it("addMonthsToKey clamps to the month end and crosses years", () => {
    expect(addMonthsToKey("2026-03-15", 12)).toBe("2027-03-15");
    expect(addMonthsToKey("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToKey("2027-01-31", 13)).toBe("2028-02-29");
    expect(addMonthsToKey("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonthsToKey("2026-05-31", -1)).toBe("2026-04-30");
    expect(() => addMonthsToKey("2026-02-31", 1)).toThrow();
    expect(() => addMonthsToKey("2026-09-30", 1.5)).toThrow();
  });

  it("formatPlainDate never moves the day", () => {
    expect(formatPlainDate("en-US", "2026-09-30", { month: "long", day: "numeric" })).toBe(
      "September 30",
    );
    expect(
      formatPlainDate("en-US", "2026-01-01", { year: "numeric", month: "short", day: "numeric" }),
    ).toBe("Jan 1, 2026");
  });

  it("zonedWallTimeToInstant resolves DST like Temporal's 'compatible'", () => {
    expect(zonedWallTimeToInstant("2027-03-28", "02:30", "Europe/Berlin").toISOString()).toBe(
      "2027-03-28T01:30:00.000Z",
    );
    expect(zonedWallTimeToInstant("2026-10-25", "02:30", "Europe/Berlin").toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(zonedWallTimeToInstant("2026-09-30", "23:59:59", "Europe/Berlin").toISOString()).toBe(
      "2026-09-30T21:59:59.000Z",
    );
    expect(() => zonedWallTimeToInstant("2026-09-30", "25:00", "Europe/Berlin")).toThrow();
    expect(() => zonedWallTimeToInstant("2026-09-30", "12:00", "Nowhere/Zone")).toThrow();
  });
});

/**
 * The calendar helpers the web's datetime port (phase 2) added. Fixed
 * instants and zones only, so the results do not depend on the process
 * zone (`pnpm test:tz` runs this file under UTC,
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

/**
 * 'reject' mode (deep-dive decision 06 §L4): the authoring forms convert a
 * typed date and time in APP_TIME_ZONE and must refuse a time that a clock
 * change repeats or skips instead of guessing. The cms's Temporal
 * wallTimeToInstant(..., "reject") refuses the same inputs
 * (apps/cms/src/utils/time-parity.test.ts).
 */
describe("zonedWallTimeToInstant in 'reject' mode", () => {
  /** The WallTimeError a call throws, or null. */
  function rejection(key: string, time: string, zone: string): WallTimeError | null {
    try {
      zonedWallTimeToInstant(key, time, zone, "reject");
      return null;
    } catch (error) {
      if (error instanceof WallTimeError) return error;
      throw error;
    }
  }

  it.each([
    // [day, time, zone, kind]
    ["2026-10-25", "02:30", "Europe/Berlin", "repeated"],
    ["2026-10-25", "02:00", "Europe/Berlin", "repeated"],
    ["2026-10-25", "02:59:59", "Europe/Berlin", "repeated"],
    ["2027-10-31", "02:30", "Europe/Berlin", "repeated"],
    ["2027-03-28", "02:30", "Europe/Berlin", "skipped"],
    ["2027-03-28", "02:00", "Europe/Berlin", "skipped"],
    ["2026-09-27", "02:30", "Pacific/Auckland", "skipped"],
    ["2027-04-04", "02:30", "Pacific/Auckland", "repeated"],
  ] as const)("%s %s in %s is %s", (key, time, zone, kind) => {
    const error = rejection(key, time, zone);
    expect(error?.kind).toBe(kind);
    expect(error).toBeInstanceOf(RangeError);
    expect(error?.name).toBe("WallTimeError");
    expect(isWallTimeError(error)).toBe(true);
    expect(error).toMatchObject({ date: key, time, timeZone: zone });
  });

  it.each([
    // The hours around the changes that exist exactly once.
    ["2026-10-25", "01:59", "Europe/Berlin", "2026-10-24T23:59:00.000Z"],
    ["2026-10-25", "03:00", "Europe/Berlin", "2026-10-25T02:00:00.000Z"],
    ["2027-03-28", "01:59", "Europe/Berlin", "2027-03-28T00:59:00.000Z"],
    ["2027-03-28", "03:00", "Europe/Berlin", "2027-03-28T01:00:00.000Z"],
    ["2026-09-30", "23:59:59", "Europe/Berlin", "2026-09-30T21:59:59.000Z"],
    ["2026-09-27", "03:00", "Pacific/Auckland", "2026-09-26T14:00:00.000Z"],
    ["2026-09-30", "12:00", "UTC", "2026-09-30T12:00:00.000Z"],
  ])("%s %s in %s is the one instant %s", (key, time, zone, iso) => {
    expect(zonedWallTimeToInstant(key, time, zone, "reject").toISOString()).toBe(iso);
    expect(zonedWallTimeToInstant(key, time, zone).toISOString()).toBe(iso);
  });

  it("keeps 'compatible' the default: the earlier instant, a gap moved forward", () => {
    expect(zonedWallTimeToInstant("2026-10-25", "02:30", "Europe/Berlin").toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(
      zonedWallTimeToInstant("2027-03-28", "02:30", "Europe/Berlin", "compatible").toISOString(),
    ).toBe("2027-03-28T01:30:00.000Z");
  });

  it("still throws a plain RangeError for a malformed input", () => {
    for (const call of [
      () => zonedWallTimeToInstant("2026-02-30", "12:00", "Europe/Berlin", "reject"),
      () => zonedWallTimeToInstant("2026-09-30", "24:00", "Europe/Berlin", "reject"),
      () => zonedWallTimeToInstant("2026-09-30", "12:00", "Mars/Olympus", "reject"),
    ]) {
      expect(call).toThrow(RangeError);
      expect(call).not.toThrow(WallTimeError);
    }
  });

  it("isWallTimeError recognises the error by name and kind, nothing else", () => {
    const foreign = Object.assign(new RangeError("x"), { name: "WallTimeError", kind: "skipped" });
    expect(isWallTimeError(foreign)).toBe(true);
    expect(isWallTimeError(new RangeError("x"))).toBe(false);
    expect(isWallTimeError(Object.assign(new Error("x"), { name: "WallTimeError" }))).toBe(false);
    expect(isWallTimeError("WallTimeError")).toBe(false);
    expect(isWallTimeError(null)).toBe(false);
  });
});

describe("zonedTimeOfDay: the HH:mm an instant shows in a zone", () => {
  it.each([
    ["2026-09-30T22:30:00.000Z", "Europe/Berlin", "00:30"],
    ["2026-10-25T00:30:00.000Z", "Europe/Berlin", "02:30"],
    ["2026-10-25T01:30:00.000Z", "Europe/Berlin", "02:30"],
    ["2027-03-28T01:00:00.000Z", "Europe/Berlin", "03:00"],
    ["2026-09-30T10:05:59.999Z", "UTC", "10:05"],
    ["2026-09-30T10:00:00+02:00", "Asia/Kathmandu", "13:45"],
  ])("%s in %s is %s", (instant, zone, time) => {
    expect(zonedTimeOfDay(instant, zone)).toBe(time);
    expect(zonedTimeOfDay(new Date(instant), zone)).toBe(time);
  });

  it("round-trips a wall time that exists once", () => {
    for (const time of ["00:00", "07:15", "12:00", "23:59"]) {
      const instant = zonedWallTimeToInstant("2026-11-03", time, "Europe/Berlin", "reject");
      expect(zonedTimeOfDay(instant, "Europe/Berlin")).toBe(time);
      expect(zonedDateKey(instant, "Europe/Berlin")).toBe("2026-11-03");
    }
  });

  it("refuses an offset-less date-time", () => {
    expect(() => zonedTimeOfDay("2026-09-30T10:00:00", "Europe/Berlin")).toThrow(/instant/);
  });
});
