import { describe, expect, it } from "vitest";

import { digestWindowStart, isDigestDue, wantsAnyDigest } from "./digest-plan";

// Mon 2026-09-07 08:00 local / Tue 2026-09-08 08:00 local.
const MONDAY = new Date(2026, 8, 7, 8, 0, 0);
const TUESDAY = new Date(2026, 8, 8, 8, 0, 0);

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
    expect(
      wantsAnyDigest({ ...base, digestAnnouncements: false, digestKudos: true }),
    ).toBe(true);
    expect(wantsAnyDigest({ ...base, blocked: true })).toBe(false);
    expect(wantsAnyDigest({ ...base, email: "" })).toBe(false);
  });
});

describe("isDigestDue", () => {
  it("daily: due once per day", () => {
    const user = { ...base, digestFrequency: "daily" };
    expect(isDigestDue(user, TUESDAY)).toBe(true);
    expect(
      isDigestDue({ ...user, lastDigestAt: new Date(2026, 8, 8, 7, 30).toISOString() }, TUESDAY),
    ).toBe(false);
    expect(
      isDigestDue({ ...user, lastDigestAt: new Date(2026, 8, 7, 7, 30).toISOString() }, TUESDAY),
    ).toBe(true);
  });

  it("weekly: only on Mondays, once per week", () => {
    expect(isDigestDue(base, MONDAY)).toBe(true);
    expect(isDigestDue(base, TUESDAY)).toBe(false);
    expect(
      isDigestDue({ ...base, lastDigestAt: new Date(2026, 8, 7, 7, 30).toISOString() }, MONDAY),
    ).toBe(false);
    // Last digest the previous week → due again this Monday.
    expect(
      isDigestDue({ ...base, lastDigestAt: new Date(2026, 7, 31, 7, 30).toISOString() }, MONDAY),
    ).toBe(true);
  });

  it("unknown frequency falls back to weekly", () => {
    expect(isDigestDue({ ...base, digestFrequency: "hourly" }, TUESDAY)).toBe(false);
    expect(isDigestDue({ ...base, digestFrequency: "hourly" }, MONDAY)).toBe(true);
  });
});

describe("digestWindowStart", () => {
  it("starts at lastDigestAt when present", () => {
    const last = new Date(2026, 8, 5, 7, 30).toISOString();
    expect(digestWindowStart({ ...base, lastDigestAt: last }, MONDAY).toISOString()).toBe(last);
  });

  it("falls back to the frequency span without a lastDigestAt", () => {
    const weekly = digestWindowStart(base, MONDAY);
    expect(MONDAY.getTime() - weekly.getTime()).toBe(7 * 86400000);
    const daily = digestWindowStart({ ...base, digestFrequency: "daily" }, MONDAY);
    expect(MONDAY.getTime() - daily.getTime()).toBe(86400000);
  });

  it("caps the window at 14 days for stale lastDigestAt", () => {
    const stale = new Date(2026, 5, 1).toISOString();
    const start = digestWindowStart({ ...base, lastDigestAt: stale }, MONDAY);
    expect(MONDAY.getTime() - start.getTime()).toBe(14 * 86400000);
  });
});
