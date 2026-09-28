import { describe, expect, it } from "vitest";
import { EMPTY_RSVP_SUMMARY, rsvpSummaryMap } from "./event-rsvp";

/**
 * The events page's view of GET /api/event-rsvps/summary (FX21). The
 * aggregation itself (dedupe per user, decliner privacy, myStatus) lives in
 * the CMS and is pinned there (apps/cms/src/utils/rsvp.test.ts, which took
 * over the characterisation cases of the old buildRsvpSummaries); here
 * only the mapping, which must never half-read a malformed row.
 */

const EVENT_A = "evta00000000000000000000";
const EVENT_B = "evtb00000000000000000000";

const summary = (target: string, extra: Record<string, unknown> = {}) => ({
  targetDocumentId: target,
  yesCount: 2,
  maybeCount: 1,
  noCount: 3,
  yesNames: ["Ada", "Grace"],
  myStatus: "maybe",
  ...extra,
});

describe("rsvpSummaryMap", () => {
  it("keys each summary by its event documentId", () => {
    const map = rsvpSummaryMap([summary(EVENT_A), summary(EVENT_B, { myStatus: null })]);
    expect(map.get(EVENT_A)).toEqual({
      yesNames: ["Ada", "Grace"],
      yesCount: 2,
      maybeCount: 1,
      noCount: 3,
      myStatus: "maybe",
    });
    expect(map.get(EVENT_B)?.myStatus).toBeNull();
  });

  it.each([
    ["no target", { targetDocumentId: undefined }],
    ["a negative count", { yesCount: -1 }],
    ["a fractional count", { noCount: 1.5 }],
    ["a string count", { maybeCount: "1" }],
    ["a missing count", { yesCount: undefined }],
  ])("drops a row with %s", (_label, extra) => {
    expect(rsvpSummaryMap([summary(EVENT_A, extra)]).size).toBe(0);
  });

  it("drops non-string names and reads an unknown myStatus as none", () => {
    const map = rsvpSummaryMap([
      summary(EVENT_A, { yesNames: ["Ada", 7, null], myStatus: "attending" }),
      summary(EVENT_B, { yesNames: "Ada" }),
    ]);
    expect(map.get(EVENT_A)).toMatchObject({ yesNames: ["Ada"], myStatus: null });
    expect(map.get(EVENT_B)?.yesNames).toEqual([]);
  });

  it("ignores non-objects and answers an empty map for no rows", () => {
    expect(rsvpSummaryMap([null, "x", 3, [summary(EVENT_A)]]).size).toBe(0);
    expect(rsvpSummaryMap([]).size).toBe(0);
  });

  it("keeps the empty summary empty", () => {
    expect(EMPTY_RSVP_SUMMARY).toEqual({
      yesNames: [],
      yesCount: 0,
      maybeCount: 0,
      noCount: 0,
      myStatus: null,
    });
  });
});
