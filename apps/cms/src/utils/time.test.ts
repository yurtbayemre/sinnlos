import { describe, expect, it } from "vitest";

import { formatPlainDate, zonedDateKey } from "./plain-date";
import {
  DEFAULT_APP_TIME_ZONE,
  addCalendarDays,
  appTimeZone,
  instantMsOrNull,
  isUtcZone,
  monthGrid,
  nextAnnual,
  offsetMinutesAt,
  parsePlainDate,
  resolveAppTimeZone,
  startOfDayInstant,
  startOfIsoWeek,
  toInstant,
  toIsoZ,
  todayIn,
  tryParsePlainDate,
  wallTimeToInstant,
  zonedDateOf,
  zonedHourOf,
} from "./time";

/**
 * Datetime contract fixtures (deep-dive decision 04, "Tests"). Every input is
 * an ISO-Z instant or a calendar date and every zone is explicit, so the
 * results must not depend on the process zone: `pnpm test:tz` runs this file
 * under TZ=UTC, Europe/Berlin and Pacific/Auckland.
 *
 * The business-zone cases run for Europe/Berlin and again for
 * America/New_York, the second APP_TIME_ZONE the decision asks for.
 */

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

describe("APP_TIME_ZONE", () => {
  it("defaults to Europe/Berlin when unset", () => {
    expect(resolveAppTimeZone(undefined)).toBe(DEFAULT_APP_TIME_ZONE);
    expect(appTimeZone({})).toBe("Europe/Berlin");
  });

  it("accepts IANA names and returns Intl's canonical spelling", () => {
    expect(resolveAppTimeZone("America/New_York")).toBe("America/New_York");
    expect(resolveAppTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(appTimeZone({ APP_TIME_ZONE: "Pacific/Auckland" })).toBe("Pacific/Auckland");
  });

  it("fails on an empty or unknown name instead of guessing", () => {
    expect(() => resolveAppTimeZone("")).toThrow(/APP_TIME_ZONE/);
    expect(() => resolveAppTimeZone("   ")).toThrow(/APP_TIME_ZONE/);
    expect(() => resolveAppTimeZone("Europe/Berlinn")).toThrow(/APP_TIME_ZONE/);
    expect(() => appTimeZone({ APP_TIME_ZONE: "CEST" })).toThrow(/IANA/);
  });
});

describe("isUtcZone", () => {
  it("accepts the names TZ=UTC resolves to and rejects offset-0 civil zones", () => {
    for (const name of ["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Zulu"]) {
      expect(isUtcZone(name), name).toBe(true);
    }
    for (const name of ["Europe/London", "Africa/Abidjan", "Europe/Berlin", "", undefined, null]) {
      expect(isUtcZone(name), String(name)).toBe(false);
    }
  });
});

describe("toInstant / toIsoZ", () => {
  it("rejects a date-time without Z or offset", () => {
    expect(() => toInstant("2026-09-24T10:00:00")).toThrow(/Z or a numeric offset/);
    expect(() => toInstant("2026-09-24")).toThrow();
    expect(() => toInstant(new Date(Number.NaN))).toThrow(/Invalid Date/);
  });

  it("accepts Z and numeric offsets and emits ISO-Z with milliseconds", () => {
    expect(toIsoZ("2026-09-24T12:00:00+02:00")).toBe("2026-09-24T10:00:00.000Z");
    expect(toIsoZ("2026-09-24T10:00:00Z")).toBe("2026-09-24T10:00:00.000Z");
    expect(toIsoZ(new Date(Date.UTC(2026, 8, 24, 10)))).toBe("2026-09-24T10:00:00.000Z");
    // Same text as Date#toISOString for the same instant.
    const date = new Date("2026-03-01T08:15:30.123Z");
    expect(toIsoZ(date)).toBe(date.toISOString());
  });

  it("instantMsOrNull maps empty and offset-less input to null", () => {
    expect(instantMsOrNull(null)).toBeNull();
    expect(instantMsOrNull("")).toBeNull();
    expect(instantMsOrNull("2026-09-24T10:00:00")).toBeNull();
    expect(instantMsOrNull("2026-09-24T10:00:00.000Z")).toBe(Date.UTC(2026, 8, 24, 10));
  });
});

describe("todayIn / zonedDateOf / zonedHourOf", () => {
  it("switches the Berlin day at 22:00Z in summer time", () => {
    expect(todayIn(BERLIN, "2026-09-24T21:59:59Z").toString()).toBe("2026-09-24");
    expect(todayIn(BERLIN, "2026-09-24T22:00:00Z").toString()).toBe("2026-09-25");
  });

  it("switches the New York day at 04:00Z in summer time", () => {
    expect(todayIn(NEW_YORK, "2026-09-25T03:59:59Z").toString()).toBe("2026-09-24");
    expect(todayIn(NEW_YORK, "2026-09-25T04:00:00Z").toString()).toBe("2026-09-25");
  });

  it("zonedDateOf agrees with zonedDateKey at 22:30Z and 23:30Z", () => {
    // Summer (CEST, +2): both already the next Berlin day.
    expect(zonedDateOf("2026-09-24T22:30:00Z", BERLIN).toString()).toBe("2026-09-25");
    expect(zonedDateKey("2026-09-24T22:30:00Z", BERLIN)).toBe("2026-09-25");
    // Winter (CET, +1): 22:30Z is still the same day, 23:30Z is the next.
    expect(zonedDateOf("2026-01-15T22:30:00Z", BERLIN).toString()).toBe("2026-01-15");
    expect(zonedDateKey("2026-01-15T22:30:00Z", BERLIN)).toBe("2026-01-15");
    expect(zonedDateOf("2026-01-15T23:30:00Z", BERLIN).toString()).toBe("2026-01-16");
    expect(zonedDateKey("2026-01-15T23:30:00Z", BERLIN)).toBe("2026-01-16");
  });

  it("zonedHourOf reads the wall clock of the zone", () => {
    expect(zonedHourOf("2026-09-24T05:30:00Z", BERLIN)).toBe(7);
    expect(zonedHourOf("2026-09-24T05:30:00Z", NEW_YORK)).toBe(1);
    expect(offsetMinutesAt("2026-08-15T19:46:42Z", BERLIN)).toBe(120);
    expect(offsetMinutesAt("2026-12-01T00:00:00Z", BERLIN)).toBe(60);
  });
});

describe("startOfDayInstant", () => {
  it("gives the 25-hour Berlin day of 2026-10-25", () => {
    const start = startOfDayInstant(parsePlainDate("2026-10-25"), BERLIN);
    const next = startOfDayInstant(parsePlainDate("2026-10-26"), BERLIN);
    expect(start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(next.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect((next.getTime() - start.getTime()) / 3600000).toBe(25);
  });

  it("gives the 23-hour Berlin day of 2027-03-28", () => {
    const start = startOfDayInstant(parsePlainDate("2027-03-28"), BERLIN);
    const next = startOfDayInstant(parsePlainDate("2027-03-29"), BERLIN);
    expect(start.toISOString()).toBe("2027-03-27T23:00:00.000Z");
    expect(next.toISOString()).toBe("2027-03-28T22:00:00.000Z");
    expect((next.getTime() - start.getTime()) / 3600000).toBe(23);
  });

  it("handles New York's DST days the same way", () => {
    const start = startOfDayInstant(parsePlainDate("2026-11-01"), NEW_YORK);
    const next = startOfDayInstant(parsePlainDate("2026-11-02"), NEW_YORK);
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect((next.getTime() - start.getTime()) / 3600000).toBe(25);
  });
});

describe("wallTimeToInstant", () => {
  it("moves a skipped wall time forward ('compatible') and rejects it on request", () => {
    const day = parsePlainDate("2027-03-28");
    expect(wallTimeToInstant(day, "02:30", BERLIN).toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(() => wallTimeToInstant(day, "02:30", BERLIN, "reject")).toThrow();
  });

  it("takes the earlier instant of a repeated wall time ('compatible')", () => {
    const day = parsePlainDate("2026-10-25");
    expect(wallTimeToInstant(day, "02:30", BERLIN).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(wallTimeToInstant(day, "02:30", BERLIN, "later").toISOString()).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });

  it("builds the poll deadline D 23:59:59 in the business zone", () => {
    const day = parsePlainDate("2026-09-30");
    expect(wallTimeToInstant(day, "23:59:59", BERLIN).toISOString()).toBe("2026-09-30T21:59:59.000Z");
    expect(wallTimeToInstant(day, "23:59:59", NEW_YORK).toISOString()).toBe(
      "2026-10-01T03:59:59.000Z",
    );
  });

  it("rejects malformed wall times", () => {
    const day = parsePlainDate("2026-09-30");
    for (const bad of ["24:00", "9:00", "23:60", "23:59:60", "noon"]) {
      expect(() => wallTimeToInstant(day, bad, BERLIN), bad).toThrow(/wall time/);
    }
  });
});

describe("addCalendarDays", () => {
  it("keeps the wall time across a DST change", () => {
    // 12:00 CEST on 2026-10-24 -> 12:00 CET on 2026-10-26 (49 hours later).
    const result = addCalendarDays("2026-10-24T10:00:00Z", 2, BERLIN);
    expect(result.toISOString()).toBe("2026-10-26T11:00:00.000Z");
  });
});

describe("parsePlainDate / tryParsePlainDate", () => {
  it("accepts real calendar days only", () => {
    expect(parsePlainDate("2028-02-29").toString()).toBe("2028-02-29");
    expect(() => parsePlainDate("2027-02-29")).toThrow(/YYYY-MM-DD/);
    expect(() => parsePlainDate("2026-9-1")).toThrow();
    expect(() => parsePlainDate("2026-09-01T00:00:00Z")).toThrow();
    expect(tryParsePlainDate("2026-02-31")).toBeNull();
    expect(tryParsePlainDate(20260901)).toBeNull();
    expect(tryParsePlainDate("2026-09-01")?.toString()).toBe("2026-09-01");
  });
});

describe("nextAnnual", () => {
  const leapBirthday = parsePlainDate("2004-02-29");

  it("puts Feb 29 on Feb 28 in a non-leap year and on Feb 29 in a leap year", () => {
    expect(nextAnnual(leapBirthday, parsePlainDate("2027-01-10")).next.toString()).toBe("2027-02-28");
    expect(nextAnnual(leapBirthday, parsePlainDate("2027-02-28"))).toMatchObject({ daysUntil: 0 });
    expect(nextAnnual(leapBirthday, parsePlainDate("2027-03-01")).next.toString()).toBe("2028-02-29");
    expect(nextAnnual(leapBirthday, parsePlainDate("2028-02-28"))).toMatchObject({ daysUntil: 1, years: 24 });
  });

  it("wraps from Dec 31 to the next year", () => {
    const result = nextAnnual(parsePlainDate("1990-01-01"), parsePlainDate("2026-12-31"));
    expect(result.next.toString()).toBe("2027-01-01");
    expect(result.daysUntil).toBe(1);
    expect(result.years).toBe(37);
  });

  it("returns daysUntil 0 on the day itself", () => {
    const result = nextAnnual(parsePlainDate("2016-09-24"), parsePlainDate("2026-09-24"));
    expect(result).toMatchObject({ daysUntil: 0, years: 10 });
    expect(result.next.toString()).toBe("2026-09-24");
  });

  it("reports years < 1 for a same-day or future start (callers skip those)", () => {
    expect(nextAnnual(parsePlainDate("2026-09-24"), parsePlainDate("2026-09-24")).years).toBe(0);
    expect(nextAnnual(parsePlainDate("2026-12-01"), parsePlainDate("2026-09-24")).years).toBe(0);
    expect(nextAnnual(parsePlainDate("2027-03-01"), parsePlainDate("2026-09-24")).years).toBeLessThan(1);
  });
});

describe("startOfIsoWeek / monthGrid", () => {
  it("maps a Sunday to the Monday before it", () => {
    expect(startOfIsoWeek(parsePlainDate("2026-09-27")).toString()).toBe("2026-09-21");
    expect(startOfIsoWeek(parsePlainDate("2026-09-21")).toString()).toBe("2026-09-21");
  });

  it("covers a month that starts on a Monday with whole weeks", () => {
    // June 2026 starts on a Monday and ends on a Tuesday.
    const days = monthGrid(2026, 6).map(String);
    expect(days[0]).toBe("2026-06-01");
    expect(days[days.length - 1]).toBe("2026-07-05");
    expect(days).toHaveLength(35);
  });

  it("covers a month that starts on a Sunday", () => {
    // November 2026 starts on a Sunday.
    const days = monthGrid(2026, 11).map(String);
    expect(days[0]).toBe("2026-10-26");
    expect(days[6]).toBe("2026-11-01");
    expect(days[days.length - 1]).toBe("2026-12-06");
    expect(days.length % 7).toBe(0);
  });

  it("covers February 2027", () => {
    const days = monthGrid(2027, 2).map(String);
    expect(days[0]).toBe("2027-02-01");
    expect(days[days.length - 1]).toBe("2027-02-28");
    expect(days).toHaveLength(28);
  });
});

describe("formatPlainDate", () => {
  it("renders the calendar day itself, never a shifted one", () => {
    expect(formatPlainDate("en-US", "2026-09-30", { month: "short", day: "numeric" })).toBe("Sep 30");
    expect(formatPlainDate("de-DE", "2026-09-30", { day: "2-digit", month: "2-digit", year: "numeric" })).toBe(
      "30.09.2026",
    );
  });
});
