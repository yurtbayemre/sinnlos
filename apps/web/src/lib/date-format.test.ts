import { createFormatter } from "next-intl";
import { describe, expect, it } from "vitest";
import { formatDateOnly, formatInstant, LONG_DAY, SHORT_DAY } from "./date-format";

/**
 * Page dates by value class (datetime contract, phase 2): instants through
 * next-intl's formatter in APP_TIME_ZONE, calendar dates as the day they
 * name. The same results in every process zone (`pnpm test:tz`).
 */
const berlin = createFormatter({ locale: "en", timeZone: "Europe/Berlin" });
const newYork = createFormatter({ locale: "en", timeZone: "America/New_York" });
const deBerlin = createFormatter({ locale: "de", timeZone: "Europe/Berlin" });

describe("formatInstant", () => {
  it("shows an instant's day in the formatter's zone: 23:30Z is the next day in Berlin", () => {
    const late = "2026-09-30T23:30:00.000Z";
    expect(formatInstant(berlin, late, LONG_DAY)).toBe("October 1, 2026");
    expect(formatInstant(newYork, late, LONG_DAY)).toBe("September 30, 2026");
    expect(formatInstant(deBerlin, late, LONG_DAY)).toBe("1. Oktober 2026");
    expect(formatInstant(berlin, new Date(late), SHORT_DAY)).toBe("Oct 1, 2026");
  });

  it("renders a time of day in the zone, across the change back to winter time", () => {
    const time = { hour: "2-digit", minute: "2-digit" } as const;
    expect(formatInstant(deBerlin, "2026-10-25T00:30:00.000Z", time)).toBe("02:30"); // CEST
    expect(formatInstant(deBerlin, "2026-10-25T01:30:00.000Z", time)).toBe("02:30"); // CET
  });

  it("renders nothing for a missing value or one that is no instant", () => {
    for (const value of [null, undefined, "", "2026-09-30T23:30:00", "2026-09-30", "garbage"]) {
      expect(formatInstant(berlin, value, LONG_DAY), String(value)).toBeNull();
    }
  });
});

describe("formatDateOnly", () => {
  it("shows the day itself, whatever the zones (no midnight instant involved)", () => {
    expect(formatDateOnly("en", "2026-09-30", LONG_DAY)).toBe("September 30, 2026");
    expect(formatDateOnly("de", "2026-09-30", LONG_DAY)).toBe("30. September 2026");
  });

  it("renders nothing for a missing or malformed day", () => {
    for (const value of [null, undefined, "", "2026-02-30", "2026-09-30T00:00:00.000Z"]) {
      expect(formatDateOnly("en", value, LONG_DAY), String(value)).toBeNull();
    }
  });
});
