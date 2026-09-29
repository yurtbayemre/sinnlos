import { describe, expect, it } from "vitest";

import { digestWindowStart, isDigestDue, wantsAnyDigest } from "./digest-plan";

/**
 * Every fixture is an ISO-Z instant and the business zone is passed
 * explicitly, so the results are the same in every process zone
 * (`pnpm test:tz`). The cron fires at 07:30 APP_TIME_ZONE.
 */

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

// Mon 2026-09-07 / Tue 2026-09-08, 07:30 in Berlin (CEST, UTC+2).
const MONDAY = new Date("2026-09-07T05:30:00.000Z");
const TUESDAY = new Date("2026-09-08T05:30:00.000Z");

const base = {
  email: "user@sinnlos.local",
  digestAnnouncements: true,
  digestFrequency: "weekly",
  lastDigestAt: null,
};

describe("wantsAnyDigest", () => {
  it("requires at least one opt-in, an email, and an unblocked account", () => {
    expect(wantsAnyDigest(base)).toBe(true);
    expect(wantsAnyDigest({ ...base, digestAnnouncements: false })).toBe(false);
    expect(wantsAnyDigest({ ...base, digestAnnouncements: false, digestKudos: true })).toBe(true);
    expect(wantsAnyDigest({ ...base, blocked: true })).toBe(false);
    expect(wantsAnyDigest({ ...base, email: "" })).toBe(false);
  });
});

describe("isDigestDue", () => {
  it("daily: due once per day", () => {
    const user = { ...base, digestFrequency: "daily" };
    expect(isDigestDue(user, TUESDAY, BERLIN)).toBe(true);
    // Sent at 07:30 Berlin today.
    expect(
      isDigestDue({ ...user, lastDigestAt: "2026-09-08T05:30:00.000Z" }, TUESDAY, BERLIN),
    ).toBe(false);
    // Sent yesterday.
    expect(
      isDigestDue({ ...user, lastDigestAt: "2026-09-07T05:30:00.000Z" }, TUESDAY, BERLIN),
    ).toBe(true);
  });

  it("daily: the day starts at midnight in the business zone, not in UTC", () => {
    const user = { ...base, digestFrequency: "daily" };
    // 23:30 Berlin on Monday is 21:30Z; 00:30 Berlin on Tuesday is 22:30Z Monday.
    const lateMonday = "2026-09-07T21:30:00.000Z";
    const earlyTuesday = "2026-09-07T22:30:00.000Z";
    expect(isDigestDue({ ...user, lastDigestAt: lateMonday }, TUESDAY, BERLIN)).toBe(true);
    expect(isDigestDue({ ...user, lastDigestAt: earlyTuesday }, TUESDAY, BERLIN)).toBe(false);
  });

  it("daily: works across the DST change (the 25-hour 2026-10-25)", () => {
    const user = { ...base, digestFrequency: "daily" };
    // Sunday 2026-10-25 07:30 CET is 06:30Z; Monday 07:30 CET is 06:30Z.
    const sunday = new Date("2026-10-25T06:30:00.000Z");
    const monday = new Date("2026-10-26T06:30:00.000Z");
    // Saturday's run at 07:30 CEST (05:30Z) → due again on Sunday.
    expect(isDigestDue({ ...user, lastDigestAt: "2026-10-24T05:30:00.000Z" }, sunday, BERLIN)).toBe(
      true,
    );
    // Sunday's run → not due again on Sunday, due on Monday.
    expect(isDigestDue({ ...user, lastDigestAt: sunday.toISOString() }, sunday, BERLIN)).toBe(
      false,
    );
    expect(isDigestDue({ ...user, lastDigestAt: sunday.toISOString() }, monday, BERLIN)).toBe(true);
    // Sent at 00:30 CEST on Sunday (22:30Z Saturday) — already Sunday in Berlin.
    expect(isDigestDue({ ...user, lastDigestAt: "2026-10-24T22:30:00.000Z" }, sunday, BERLIN)).toBe(
      false,
    );
  });

  it("weekly: once per ISO week", () => {
    expect(isDigestDue(base, MONDAY, BERLIN)).toBe(true);
    expect(isDigestDue({ ...base, lastDigestAt: "2026-09-07T05:30:00.000Z" }, MONDAY, BERLIN)).toBe(
      false,
    );
    expect(
      isDigestDue({ ...base, lastDigestAt: "2026-09-07T05:30:00.000Z" }, TUESDAY, BERLIN),
    ).toBe(false);
    // Last digest the previous week → due again this Monday.
    expect(isDigestDue({ ...base, lastDigestAt: "2026-08-31T05:30:00.000Z" }, MONDAY, BERLIN)).toBe(
      true,
    );
    // Sunday evening still belongs to the week of that Monday's digest.
    const sundayEvening = new Date("2026-09-13T19:30:00.000Z"); // 21:30 Berlin
    expect(
      isDigestDue({ ...base, lastDigestAt: "2026-09-07T05:30:00.000Z" }, sundayEvening, BERLIN),
    ).toBe(false);
  });

  it("weekly: never sent → due on any day (a new subscriber gets the next morning's run)", () => {
    expect(isDigestDue(base, TUESDAY, BERLIN)).toBe(true);
  });

  it("weekly: Monday 00:30 Berlin is Sunday 22:30Z and already belongs to the new week", () => {
    const mondayJustAfterMidnight = "2026-09-06T22:30:00.000Z";
    expect(isDigestDue({ ...base, lastDigestAt: mondayJustAfterMidnight }, MONDAY, BERLIN)).toBe(
      false,
    );
    // One hour earlier is still Sunday in Berlin: last week.
    expect(isDigestDue({ ...base, lastDigestAt: "2026-09-06T21:30:00.000Z" }, MONDAY, BERLIN)).toBe(
      true,
    );
  });

  it("weekly: a Tuesday after a failed Monday is due (catch-up, FX48)", () => {
    expect(
      isDigestDue({ ...base, lastDigestAt: "2026-08-31T05:30:00.000Z" }, TUESDAY, BERLIN),
    ).toBe(true);
    // Once Tuesday's run sent it, the rest of the week is quiet.
    const wednesday = new Date("2026-09-09T05:30:00.000Z");
    expect(isDigestDue({ ...base, lastDigestAt: TUESDAY.toISOString() }, wednesday, BERLIN)).toBe(
      false,
    );
  });

  it("weekly: the week starts at Monday 00:00 in the zone, across the DST change", () => {
    // Week of Monday 2026-10-26 (after the 25-hour Sunday): it starts at
    // 00:00 CET = 2026-10-25T23:00Z.
    const tuesday = new Date("2026-10-27T06:30:00.000Z");
    expect(
      isDigestDue({ ...base, lastDigestAt: "2026-10-25T22:59:00.000Z" }, tuesday, BERLIN),
    ).toBe(true);
    expect(
      isDigestDue({ ...base, lastDigestAt: "2026-10-25T23:00:00.000Z" }, tuesday, BERLIN),
    ).toBe(false);
  });

  // Sent Monday 03:00 in Berlin = Sunday 21:00 in New York.
  const SENT_EARLY_MONDAY = "2026-09-07T01:00:00.000Z";

  it("uses the business zone's week, not the UTC one", () => {
    // 2026-09-08T03:30Z is Tuesday 05:30 in Berlin but Monday 23:30 in New
    // York: the digest from Monday 03:00 Berlin is this week's in Berlin,
    // last week's in New York.
    const instant = new Date("2026-09-08T03:30:00.000Z");
    const user = { ...base, lastDigestAt: SENT_EARLY_MONDAY };
    expect(isDigestDue(user, instant, BERLIN)).toBe(false);
    expect(isDigestDue(user, instant, NEW_YORK)).toBe(true);
  });

  it("defaults to APP_TIME_ZONE (Europe/Berlin when unset)", () => {
    const previous = process.env.APP_TIME_ZONE;
    delete process.env.APP_TIME_ZONE;
    const user = { ...base, lastDigestAt: SENT_EARLY_MONDAY };
    try {
      expect(isDigestDue(user, new Date("2026-09-08T03:30:00.000Z"))).toBe(false);
      process.env.APP_TIME_ZONE = NEW_YORK;
      expect(isDigestDue(user, new Date("2026-09-08T03:30:00.000Z"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.APP_TIME_ZONE;
      else process.env.APP_TIME_ZONE = previous;
    }
  });

  it("treats an unparseable lastDigestAt as never sent", () => {
    const user = { ...base, digestFrequency: "daily" };
    expect(isDigestDue({ ...user, lastDigestAt: "garbage" }, TUESDAY, BERLIN)).toBe(true);
    expect(isDigestDue({ ...user, lastDigestAt: "2026-09-08T07:00:00" }, TUESDAY, BERLIN)).toBe(
      true,
    );
  });

  it("unknown frequency falls back to weekly", () => {
    // Monday's digest sent: a daily user would be due on Tuesday, a weekly one not.
    const sentMonday = { ...base, lastDigestAt: "2026-09-07T05:30:00.000Z" };
    expect(isDigestDue({ ...sentMonday, digestFrequency: "daily" }, TUESDAY, BERLIN)).toBe(true);
    expect(isDigestDue({ ...sentMonday, digestFrequency: "hourly" }, TUESDAY, BERLIN)).toBe(false);
    expect(isDigestDue({ ...base, digestFrequency: "hourly" }, MONDAY, BERLIN)).toBe(true);
  });
});

describe("digestWindowStart", () => {
  it("starts at lastDigestAt when present", () => {
    const last = "2026-09-05T05:30:00.000Z";
    expect(digestWindowStart({ ...base, lastDigestAt: last }, MONDAY).toISOString()).toBe(last);
  });

  it("falls back to the frequency span without a lastDigestAt", () => {
    const weekly = digestWindowStart(base, MONDAY);
    expect(MONDAY.getTime() - weekly.getTime()).toBe(7 * 86400000);
    const daily = digestWindowStart({ ...base, digestFrequency: "daily" }, MONDAY);
    expect(MONDAY.getTime() - daily.getTime()).toBe(86400000);
  });

  it("caps the window at 14 days for stale lastDigestAt", () => {
    const stale = "2026-06-01T00:00:00.000Z";
    const start = digestWindowStart({ ...base, lastDigestAt: stale }, MONDAY);
    expect(MONDAY.getTime() - start.getTime()).toBe(14 * 86400000);
  });
});
