import { describe, expect, it } from "vitest";

import {
  addDaysToKey,
  canonicalTimeZone,
  formatPlainDate,
  isPlainDate,
  isValidTimeZone,
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
  });

  it("zonedDateKey requires a real instant", () => {
    expect(() => zonedDateKey("2026-09-24T10:00:00", "Europe/Berlin")).toThrow(/instant/);
    expect(() => zonedDateKey(new Date(Number.NaN), "Europe/Berlin")).toThrow();
    expect(zonedDateKey("2026-09-24T23:30:00+02:00", "Europe/Berlin")).toBe("2026-09-24");
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
