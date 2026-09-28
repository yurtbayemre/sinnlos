import { describe, expect, it } from "vitest";
import { EMPTY_RSVP_SUMMARY, buildRsvpSummaries } from "./event-rsvp";
import type { EventRsvp, RsvpStatus } from "./types";

/**
 * Characterisation of the events page's RSVP aggregation (WD02), written
 * against the function as it was moved out of app/(app)/events/page.tsx.
 * Rows come from /api/event-rsvps sorted by respondedAt, then id; the CMS
 * strips the user from maybe/no rows of other people.
 */

const EVENT_A = "evta00000000000000000000";
const EVENT_B = "evtb00000000000000000000";
const ME = 7;

let nextId = 1;
function row(
  target: string,
  status: RsvpStatus,
  user: { id: number; displayName?: string } | null,
  respondedAt: string | null = null,
): EventRsvp {
  return { id: nextId++, targetDocumentId: target, status, respondedAt, user };
}

describe("buildRsvpSummaries", () => {
  it("counts each bucket and lists the yes names", () => {
    const map = buildRsvpSummaries(
      [
        row(EVENT_A, "yes", { id: 1, displayName: "Ada" }),
        row(EVENT_A, "yes", { id: 2, displayName: "Grace" }),
        row(EVENT_A, "maybe", { id: 3 }),
        row(EVENT_A, "no", { id: 4 }),
        row(EVENT_B, "no", { id: 1, displayName: "Ada" }),
      ],
      null,
    );
    expect(map.get(EVENT_A)).toEqual({
      yesNames: ["Ada", "Grace"],
      yesCount: 2,
      maybeCount: 1,
      noCount: 1,
      myStatus: null,
    });
    expect(map.get(EVENT_B)).toEqual({
      yesNames: [],
      yesCount: 0,
      maybeCount: 0,
      noCount: 1,
      myStatus: null,
    });
  });

  it("collapses duplicate rows of one user to the latest respondedAt", () => {
    const map = buildRsvpSummaries(
      [
        row(EVENT_A, "yes", { id: 1, displayName: "Ada" }, "2026-09-10T10:00:00.000Z"),
        row(EVENT_A, "no", { id: 1, displayName: "Ada" }, "2026-09-10T11:00:00.000Z"),
        row(EVENT_A, "maybe", { id: 1, displayName: "Ada" }, "2026-09-10T09:00:00.000Z"),
      ],
      null,
    );
    expect(map.get(EVENT_A)).toMatchObject({ yesCount: 0, maybeCount: 0, noCount: 1 });
  });

  it("lets the later row win a respondedAt tie (the list is sorted by id last)", () => {
    const at = "2026-09-10T10:00:00.000Z";
    const map = buildRsvpSummaries(
      [
        row(EVENT_A, "no", { id: 1, displayName: "Ada" }, at),
        row(EVENT_A, "yes", { id: 1, displayName: "Ada" }, at),
      ],
      null,
    );
    expect(map.get(EVENT_A)).toMatchObject({ yesNames: ["Ada"], yesCount: 1, noCount: 0 });
  });

  it("treats a missing respondedAt as the oldest answer", () => {
    const map = buildRsvpSummaries(
      [
        row(EVENT_A, "yes", { id: 1 }, "2026-09-10T10:00:00.000Z"),
        row(EVENT_A, "no", { id: 1 }, null),
      ],
      null,
    );
    expect(map.get(EVENT_A)).toMatchObject({ yesCount: 1, noCount: 0 });
  });

  it("counts every stripped row separately and names nobody", () => {
    // The CMS removes `user` from other people's maybe/no rows: they cannot
    // be deduplicated, so each row counts.
    const map = buildRsvpSummaries(
      [row(EVENT_A, "no", null), row(EVENT_A, "no", null), row(EVENT_A, "maybe", null)],
      ME,
    );
    expect(map.get(EVENT_A)).toEqual({
      yesNames: [],
      yesCount: 0,
      maybeCount: 1,
      noCount: 2,
      myStatus: null,
    });
  });

  it("counts a yes without a display name but lists no name for it", () => {
    const map = buildRsvpSummaries([row(EVENT_A, "yes", { id: 1 })], null);
    expect(map.get(EVENT_A)).toMatchObject({ yesNames: [], yesCount: 1 });
  });

  it("derives myStatus from the caller's latest row only", () => {
    const map = buildRsvpSummaries(
      [
        row(EVENT_A, "yes", { id: ME, displayName: "Me" }, "2026-09-10T10:00:00.000Z"),
        row(EVENT_A, "maybe", { id: ME, displayName: "Me" }, "2026-09-10T12:00:00.000Z"),
        row(EVENT_A, "yes", { id: 1, displayName: "Ada" }, "2026-09-10T13:00:00.000Z"),
      ],
      ME,
    );
    expect(map.get(EVENT_A)).toMatchObject({ myStatus: "maybe", yesNames: ["Ada"] });
    // Without a caller id nothing is "mine".
    expect(buildRsvpSummaries([row(EVENT_A, "yes", { id: ME })], null).get(EVENT_A)?.myStatus).toBe(
      null,
    );
  });

  it("skips rows without a target and answers an empty map for no rows", () => {
    const orphan = { ...row(EVENT_A, "yes", { id: 1 }), targetDocumentId: "" };
    expect(buildRsvpSummaries([orphan], null).size).toBe(0);
    expect(buildRsvpSummaries([], ME).size).toBe(0);
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
