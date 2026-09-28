import { describe, expect, it } from "vitest";
import {
  classifiedToday,
  dateInDays,
  formatAdExpiry,
  isClassifiedExpired,
} from "./classified-shared";

/**
 * Marketplace days (datetime contract, phase 2): "today" is the day in
 * APP_TIME_ZONE, expiresAt a calendar date. The old code took the process
 * zone's day, so a web container in UTC would have kept yesterday's ads
 * listed until 02:00 Berlin time. Fixed instants: the same result in every
 * process zone (`pnpm test:tz`).
 */
const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
/** 23:30Z on 30 Sep: already 1 Oct, 01:30 in Berlin; still 30 Sep, 19:30 in New York. */
const LATE = new Date("2026-09-30T23:30:00.000Z");

describe("classifiedToday / dateInDays", () => {
  it("take the day in the given zone", () => {
    expect(classifiedToday(BERLIN, LATE)).toBe("2026-10-01");
    expect(classifiedToday(NEW_YORK, LATE)).toBe("2026-09-30");
    expect(classifiedToday("UTC", LATE)).toBe("2026-09-30");
  });

  it("count lifetimes in calendar days from that day", () => {
    expect(dateInDays(30, BERLIN, LATE)).toBe("2026-10-31");
    expect(dateInDays(30, NEW_YORK, LATE)).toBe("2026-10-30");
    expect(dateInDays(0, BERLIN, LATE)).toBe("2026-10-01");
    // Across the change back to winter time and the year end.
    expect(dateInDays(90, BERLIN, new Date("2026-10-24T22:30:00.000Z"))).toBe("2027-01-23");
  });
});

describe("isClassifiedExpired", () => {
  it("at 23:30Z: an ad that expired on 30 Sep is expired in Berlin, still active in New York", () => {
    expect(isClassifiedExpired("2026-09-30", classifiedToday(BERLIN, LATE))).toBe(true);
    expect(isClassifiedExpired("2026-09-30", classifiedToday(NEW_YORK, LATE))).toBe(false);
  });

  it("keeps an ad expiring today active for the rest of the day", () => {
    expect(isClassifiedExpired("2026-10-01", "2026-10-01")).toBe(false);
    expect(isClassifiedExpired("2026-10-02", "2026-10-01")).toBe(false);
    expect(isClassifiedExpired("2026-09-30", "2026-10-01")).toBe(true);
  });

  it("never counts a missing or malformed date as expired", () => {
    for (const value of [undefined, "", "2026-9-30", "2026-09-30T00:00:00.000Z", "garbage"]) {
      expect(isClassifiedExpired(value, "2026-10-01"), String(value)).toBe(false);
    }
  });
});

describe("formatAdExpiry", () => {
  it("formats the calendar date itself, in the locale's numeric form", () => {
    expect(formatAdExpiry("2026-09-30", "de")).toBe("30.9.2026");
    expect(formatAdExpiry("2026-09-30", "en")).toBe("9/30/2026");
  });

  it("shows a value that is no calendar date as it is", () => {
    expect(formatAdExpiry("soon", "en")).toBe("soon");
  });
});
