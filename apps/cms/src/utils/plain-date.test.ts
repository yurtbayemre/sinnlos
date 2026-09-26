import { describe, expect, it } from "vitest";

import {
  addDaysToKey,
  canonicalTimeZone,
  formatPlainDate,
  instantEpochMs,
  isPlainDate,
  isValidTimeZone,
  resolveAppTimeZone,
  zonedDateKey,
  zonedWallTimeToInstant,
} from "./plain-date";

describe("plain-date", () => {
  it("isPlainDate accepts real days in YYYY-MM-DD only", () => {
    expect(isPlainDate("2026-09-30")).toBe(true);
    expect(isPlainDate("2028-02-29")).toBe(true);
    for (const bad of ["2027-02-29", "2026-02-31", "2026-13-01", "2026-00-10", "2026-9-30", "", null, 20260930]) {
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

  it("formatPlainDate never moves the day", () => {
    expect(formatPlainDate("en-US", "2026-09-30", { month: "long", day: "numeric" })).toBe("September 30");
    expect(formatPlainDate("en-US", "2026-01-01", { year: "numeric", month: "short", day: "numeric" })).toBe(
      "Jan 1, 2026",
    );
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
