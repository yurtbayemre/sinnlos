import { describe, expect, it } from "vitest";
import { relativeTime, type RelativeTimeT } from "./relative-time";

/**
 * relativeTime (FX49, datetime contract C6): elapsed-time labels below a
 * day for notifications, calendar-day labels in APP_TIME_ZONE otherwise,
 * and the day itself in the app locale from 7 days on. Fixed instants and
 * zones, so the labels do not depend on the process zone (`pnpm test:tz`).
 */
const t: RelativeTimeT = (key, values) =>
  values ? `${key}(${Object.values(values).join(",")})` : key;

const BERLIN = "Europe/Berlin";
const at = (iso: string) => new Date(iso);
const day = (input: string | Date | null | undefined, now: string, extra: object = {}) =>
  relativeTime(input, t, { locale: "en", timeZone: BERLIN, now: at(now), ...extra });
const minute = (input: string, now: string, timeZone = BERLIN) =>
  relativeTime(input, t, { locale: "en", timeZone, granularity: "minute", now: at(now) });

describe("relativeTime: calendar days in APP_TIME_ZONE", () => {
  it("says yesterday at 00:10 for 23:50 the evening before, 20 minutes ago", () => {
    // 21:50Z = 23:50 on 1 Oct, 22:10Z = 00:10 on 2 Oct in Berlin.
    expect(day("2026-10-01T21:50:00.000Z", "2026-10-01T22:10:00.000Z")).toBe("yesterday");
    // The same instants are one UTC day: the zone decides, not the elapsed time.
    expect(
      relativeTime("2026-10-01T21:50:00.000Z", t, {
        locale: "en",
        timeZone: "UTC",
        now: at("2026-10-01T22:10:00.000Z"),
      }),
    ).toBe("today");
  });

  it("says today for earlier the same day, even 15 hours ago", () => {
    expect(day("2026-10-01T06:00:00.000Z", "2026-10-01T21:50:00.000Z")).toBe("today");
  });

  it("counts calendar days up to six, then shows the day", () => {
    const now = "2026-10-01T10:00:00.000Z";
    expect(day("2026-09-29T21:59:00.000Z", now)).toBe("daysAgo(2)"); // 29 Sep 23:59
    expect(day("2026-09-29T22:01:00.000Z", now)).toBe("yesterday"); // 30 Sep 00:01
    expect(day("2026-09-25T10:00:00.000Z", now)).toBe("daysAgo(6)");
    expect(day("2026-09-24T10:00:00.000Z", now)).toBe("Sep 24");
    expect(day("2026-09-24T10:00:00.000Z", now, { longDate: true })).toBe("Sep 24, 2026");
  });

  it("counts calendar days across the DST changes, not 24-hour steps", () => {
    // 25 Oct 00:30 CEST to 26 Oct 00:30 CET: 25 hours, one day.
    expect(day("2026-10-24T22:30:00.000Z", "2026-10-25T23:30:00.000Z")).toBe("yesterday");
    // 28 Mar 01:30 CET to 29 Mar 00:30 CEST: 22 hours, one day.
    expect(day("2027-03-28T00:30:00.000Z", "2027-03-28T22:30:00.000Z")).toBe("yesterday");
    // 25 Oct 00:10 CEST to 25 Oct 23:20 CET: 24 h 10 min, still that day.
    expect(day("2026-10-24T22:10:00.000Z", "2026-10-25T22:20:00.000Z")).toBe("today");
  });

  it("formats the day in the app locale and in APP_TIME_ZONE", () => {
    // 23:30Z on 23 Sep is 24 Sep in Berlin, still 23 Sep in New York.
    const input = "2026-09-23T23:30:00.000Z";
    const now = at("2026-10-05T10:00:00.000Z");
    expect(relativeTime(input, t, { locale: "de", timeZone: BERLIN, now })).toBe("24. Sept.");
    expect(relativeTime(input, t, { locale: "en", timeZone: BERLIN, now })).toBe("Sep 24");
    expect(relativeTime(input, t, { locale: "de", timeZone: BERLIN, now, longDate: true })).toBe(
      "24. Sept. 2026",
    );
    expect(relativeTime(input, t, { locale: "en", timeZone: "America/New_York", now })).toBe(
      "Sep 23",
    );
  });

  it("treats a future instant (clock skew) as today", () => {
    expect(day("2026-10-01T10:05:00.000Z", "2026-10-01T10:00:00.000Z")).toBe("today");
  });
});

describe("relativeTime: minute granularity (notifications)", () => {
  const now = "2026-10-02T00:30:00.000Z";

  it("uses the elapsed time below 24 hours", () => {
    expect(minute("2026-10-02T00:29:31.000Z", now)).toBe("justNow");
    expect(minute("2026-10-02T00:25:00.000Z", now)).toBe("minutesAgo(5)");
    expect(minute("2026-10-01T21:30:00.000Z", now)).toBe("hoursAgo(3)");
    expect(minute("2026-10-01T00:31:00.000Z", now)).toBe("hoursAgo(23)");
  });

  it("then counts calendar days in APP_TIME_ZONE, at least one", () => {
    // 1 Oct 02:30 to 2 Oct 02:30 Berlin: one day.
    expect(minute("2026-10-01T00:30:00.000Z", now)).toBe("daysAgo(1)");
    // 29 Sep 23:59 Berlin to 2 Oct 02:30: three calendar days.
    expect(minute("2026-09-29T21:59:00.000Z", now)).toBe("daysAgo(3)");
    // 24 h 10 min within the 25-hour day: one day, not zero.
    expect(minute("2026-10-24T22:10:00.000Z", "2026-10-25T22:20:00.000Z")).toBe("daysAgo(1)");
    expect(minute("2026-09-24T12:00:00.000Z", now)).toBe("Sep 24");
  });
});

describe("relativeTime: inputs", () => {
  const now = "2026-10-01T10:00:00.000Z";

  it("takes a Date or an ISO string with Z or an offset", () => {
    expect(day(at("2026-10-01T08:00:00.000Z"), now)).toBe("today");
    expect(day("2026-10-01T01:00:00+02:00", now)).toBe("today");
    expect(day("2026-09-30T23:30:00-02:00", now)).toBe("today"); // 1 Oct 03:30 Berlin
  });

  it("renders nothing for a missing value, an offset-less date-time or garbage", () => {
    for (const input of [null, undefined, "", "2026-10-01T08:00:00", "2026-10-01", "garbage"]) {
      expect(day(input, now), String(input)).toBe("");
    }
    expect(day(new Date(Number.NaN), now)).toBe("");
  });
});
