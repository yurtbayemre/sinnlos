import { describe, expect, it } from "vitest";

import { isPollClosed } from "./poll-close";

const CLOSES_AT = "2026-09-30T21:59:59.000Z";

describe("isPollClosed (cms)", () => {
  it("is closed iff now >= closesAt", () => {
    expect(isPollClosed(CLOSES_AT, new Date("2026-09-30T21:59:58.999Z"))).toBe(false);
    expect(isPollClosed(CLOSES_AT, new Date(CLOSES_AT))).toBe(true);
    expect(isPollClosed(CLOSES_AT, new Date("2026-09-30T22:00:00.000Z"))).toBe(true);
    expect(isPollClosed(new Date(CLOSES_AT), new Date(CLOSES_AT))).toBe(true);
  });

  it("never closes without a closesAt, and treats garbage as open", () => {
    expect(isPollClosed(null, new Date())).toBe(false);
    expect(isPollClosed(undefined, new Date())).toBe(false);
    expect(isPollClosed("", new Date())).toBe(false);
    expect(isPollClosed("not a date", new Date())).toBe(false);
  });
});
