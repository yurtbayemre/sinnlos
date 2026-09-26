import { describe, expect, it } from "vitest";

import { clampExpiresAt } from "./classified-expiry";
import { parsePlainDate, todayIn } from "./time";

const TODAY = parsePlainDate("2026-09-24");

describe("clampExpiresAt", () => {
  it("defaults a missing or invalid value to today + 30", () => {
    for (const value of [undefined, null, "", "   ", "soon", "2026-02-31", 20261024]) {
      expect(clampExpiresAt(value, TODAY), String(value)).toBe("2026-10-24");
    }
  });

  it("keeps a date inside [today, today + 90]", () => {
    expect(clampExpiresAt("2026-09-24", TODAY)).toBe("2026-09-24");
    expect(clampExpiresAt("2026-11-01", TODAY)).toBe("2026-11-01");
    expect(clampExpiresAt("2026-12-23", TODAY)).toBe("2026-12-23");
  });

  it("clamps to the floor today and the ceiling today + 90", () => {
    expect(clampExpiresAt("2026-09-23", TODAY)).toBe("2026-09-24");
    expect(clampExpiresAt("2020-01-01", TODAY)).toBe("2026-09-24");
    expect(clampExpiresAt("2026-12-24", TODAY)).toBe("2026-12-23");
    expect(clampExpiresAt("2030-01-01", TODAY)).toBe("2026-12-23");
  });

  it("uses today in the business zone: 23:30Z on Sep 24 is already Sep 25 in Berlin", () => {
    const berlinToday = todayIn("Europe/Berlin", "2026-09-24T23:30:00Z");
    expect(clampExpiresAt("2026-09-24", berlinToday)).toBe("2026-09-25");
    expect(clampExpiresAt(undefined, berlinToday)).toBe("2026-10-25");
    // Still Sep 24 in New York at that instant.
    const newYorkToday = todayIn("America/New_York", "2026-09-24T23:30:00Z");
    expect(clampExpiresAt("2026-09-24", newYorkToday)).toBe("2026-09-24");
  });

  it("reads an instant with an offset as its calendar day in the business zone", () => {
    expect(clampExpiresAt("2026-10-01T22:30:00Z", TODAY, "Europe/Berlin")).toBe("2026-10-02");
    expect(clampExpiresAt("2026-10-01T22:30:00Z", TODAY, "America/New_York")).toBe("2026-10-01");
    // Offset-less date-times are not instants: default.
    expect(clampExpiresAt("2026-10-01T12:00:00", TODAY, "Europe/Berlin")).toBe("2026-10-24");
  });
});
