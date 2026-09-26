import { describe, expect, it } from "vitest";

import { isPollClosed, pollClosesAtForDay } from "./poll-close";

/**
 * The web half of the poll close rule. The same boundary cases as the cms
 * (apps/cms/src/utils/poll-close.test.ts): closed iff now >= closesAt.
 */
const CLOSES_AT = "2026-09-30T21:59:59.000Z";

describe("isPollClosed (web)", () => {
  it("is closed iff now >= closesAt, including exact equality", () => {
    expect(isPollClosed(CLOSES_AT, new Date("2026-09-30T21:59:58.999Z"))).toBe(false);
    expect(isPollClosed(CLOSES_AT, new Date(CLOSES_AT))).toBe(true);
    expect(isPollClosed(CLOSES_AT, new Date("2026-10-01T00:00:00.000Z"))).toBe(true);
  });

  it("never closes without a closesAt and treats garbage as open", () => {
    expect(isPollClosed(null)).toBe(false);
    expect(isPollClosed(undefined)).toBe(false);
    expect(isPollClosed("")).toBe(false);
    expect(isPollClosed("2026-09-30T21:59:59", new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("treats a bare calendar date as no instant (open), like the cms", () => {
    // Its '-DD' is no offset; Date.parse alone would read UTC midnight.
    expect(isPollClosed("2026-10-01", new Date("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isPollClosed("2026-10-01T00:00:00Z", new Date("2030-01-01T00:00:00Z"))).toBe(true);
  });
});

describe("pollClosesAtForDay", () => {
  it("is 23:59:59 on the day in the business zone, as ISO-Z", () => {
    expect(pollClosesAtForDay("2026-09-30", "Europe/Berlin")).toBe("2026-09-30T21:59:59.000Z");
    // Winter time (CET, +1).
    expect(pollClosesAtForDay("2026-12-01", "Europe/Berlin")).toBe("2026-12-01T22:59:59.000Z");
    // The day of the DST change still ends at 23:59:59 local time.
    expect(pollClosesAtForDay("2026-10-25", "Europe/Berlin")).toBe("2026-10-25T22:59:59.000Z");
    expect(pollClosesAtForDay("2026-09-30", "America/New_York")).toBe("2026-10-01T03:59:59.000Z");
  });

  it("rejects anything that is not a calendar date", () => {
    expect(pollClosesAtForDay("2026-02-31", "Europe/Berlin")).toBeNull();
    expect(pollClosesAtForDay("30.09.2026", "Europe/Berlin")).toBeNull();
    expect(pollClosesAtForDay("2026-09-30T12:00", "Europe/Berlin")).toBeNull();
  });

  it("closes the poll exactly at the end of the chosen day", () => {
    const closesAt = pollClosesAtForDay("2026-09-30", "Europe/Berlin");
    // 23:59:58 Berlin: still open; 00:00 Berlin on Oct 1: closed.
    expect(isPollClosed(closesAt, new Date("2026-09-30T21:59:58.000Z"))).toBe(false);
    expect(isPollClosed(closesAt, new Date("2026-09-30T22:00:00.000Z"))).toBe(true);
  });
});
