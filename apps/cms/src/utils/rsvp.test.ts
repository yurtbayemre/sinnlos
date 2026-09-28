import { describe, expect, it } from "vitest";
import {
  MAX_SUMMARY_TARGETS,
  RSVP_STATUSES,
  capacityDecision,
  compareNewestFirst,
  filtersReferenceUser,
  isRsvpStatus,
  newestFirst,
  parseSummaryTargets,
  pickSurvivor,
  requestsLegacyFormat,
  rowUserId,
  seatHolders,
  stripPrivateUsers,
  summarizeRsvps,
  type RsvpRow,
} from "./rsvp";

/**
 * Pure RSVP rules (FX21). The controller suite (event-rsvp.test.ts) pins
 * them through the upsert, the capacity gate and the read filter; these pin
 * the rules themselves, including the healing order and the seat count
 * (one answer per user, the newest, as in the summary).
 */

const row = (
  id: number,
  userId: number | null,
  status: string,
  respondedAt: string | Date | null = null,
): RsvpRow => ({ id, user: userId === null ? null : { id: userId }, status, respondedAt });

describe("isRsvpStatus", () => {
  it("accepts exactly yes, no and maybe", () => {
    expect(RSVP_STATUSES).toEqual(["yes", "no", "maybe"]);
    for (const status of RSVP_STATUSES) expect(isRsvpStatus(status)).toBe(true);
    for (const value of ["YES", "", "constructor", "toString", null, undefined, 1, ["yes"]]) {
      expect(isRsvpStatus(value), String(value)).toBe(false);
    }
  });
});

describe("healing order: pickSurvivor / newestFirst", () => {
  it("keeps the newest respondedAt", () => {
    const rows = [
      row(1, 5, "yes", "2026-09-10T10:00:00.000Z"),
      row(2, 5, "no", "2026-09-10T12:00:00.000Z"),
      row(3, 5, "maybe", "2026-09-10T11:00:00.000Z"),
    ];
    expect(pickSurvivor(rows)?.id).toBe(2);
    expect(newestFirst(rows).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("breaks a respondedAt tie by the higher id", () => {
    const at = "2026-09-10T10:00:00.000Z";
    expect(pickSurvivor([row(3, 5, "no", at), row(7, 5, "yes", at), row(4, 5, "no", at)])?.id).toBe(
      7,
    );
  });

  it("treats a missing respondedAt as the oldest", () => {
    expect(
      pickSurvivor([row(9, 5, "yes", null), row(2, 5, "no", "2026-01-01T00:00:00.000Z")])?.id,
    ).toBe(2);
    // Two rows without a time: the higher id.
    expect(pickSurvivor([row(2, 5, "yes"), row(9, 5, "no")])?.id).toBe(9);
  });

  it("reads Date objects like ISO strings", () => {
    const rows = [
      row(1, 5, "yes", new Date("2026-09-10T12:00:00.000Z")),
      row(2, 5, "no", "2026-09-10T11:00:00.000Z"),
    ];
    expect(pickSurvivor(rows)?.id).toBe(1);
    expect(compareNewestFirst(rows[0]!, rows[1]!)).toBeLessThan(0);
  });

  it("answers null for no rows and never mutates its input", () => {
    expect(pickSurvivor([])).toBeNull();
    const rows = [
      row(1, 5, "yes", "2026-01-01T00:00:00.000Z"),
      row(2, 5, "no", "2026-02-01T00:00:00.000Z"),
    ];
    newestFirst(rows);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("seatHolders", () => {
  it("counts users, not rows", () => {
    expect(
      seatHolders([row(1, 8, "yes"), row(2, 8, "yes"), row(3, 9, "yes"), row(4, 10, "no")]),
    ).toBe(2);
  });

  it("never counts the excluded caller, and ignores rows without a user", () => {
    const rows = [row(1, 8, "yes"), row(2, 5, "yes"), row(3, null, "yes")];
    expect(seatHolders(rows, 5)).toBe(1);
    expect(seatHolders(rows)).toBe(2);
    expect(seatHolders(rows, null)).toBe(2);
  });

  it("counts yes answers only", () => {
    expect(seatHolders([row(1, 8, "maybe"), row(2, 9, "no")])).toBe(0);
  });

  it("reads only a user's newest row, like the summary", () => {
    const older = "2026-09-10T10:00:00.000Z";
    const newer = "2026-09-10T11:00:00.000Z";
    // An older yes next to a newer no or maybe holds no seat.
    expect(seatHolders([row(1, 8, "yes", older), row(2, 8, "no", newer)])).toBe(0);
    expect(seatHolders([row(2, 8, "maybe", newer), row(1, 8, "yes", older)])).toBe(0);
    // An older no next to a newer yes holds one.
    expect(seatHolders([row(1, 8, "no", older), row(2, 8, "yes", newer)])).toBe(1);
    // A respondedAt tie goes to the higher id; no time at all is the oldest.
    expect(seatHolders([row(7, 8, "yes", older), row(3, 8, "no", older)])).toBe(1);
    expect(seatHolders([row(3, 8, "yes", older), row(7, 8, "no", older)])).toBe(0);
    expect(seatHolders([row(9, 8, "yes"), row(2, 8, "no", older)])).toBe(0);
  });

  it("agrees with the summary's yesCount, except for rows whose user is gone", () => {
    const target = "evtc00000000000000000000";
    const onTarget = (r: RsvpRow): RsvpRow => ({ ...r, targetDocumentId: target });
    const rows = [
      row(1, 8, "yes", "2026-09-10T10:00:00.000Z"),
      row(2, 8, "no", "2026-09-10T11:00:00.000Z"),
      row(3, 9, "no", "2026-09-10T10:00:00.000Z"),
      row(4, 9, "yes", "2026-09-10T11:00:00.000Z"),
      row(5, 10, "yes", "2026-09-10T10:00:00.000Z"),
      row(6, 10, "yes", "2026-09-10T10:00:00.000Z"),
      row(7, 11, "maybe", "2026-09-10T12:00:00.000Z"),
    ].map(onTarget);
    expect(seatHolders(rows)).toBe(2);
    expect(summarizeRsvps(rows, [target], null)[0]?.yesCount).toBe(2);
    // The known difference: a deleted user's yes counts in the summary but
    // holds no seat (unchanged since a88d45a).
    const withOrphan = [...rows, onTarget(row(8, null, "yes", "2026-09-10T13:00:00.000Z"))];
    expect(seatHolders(withOrphan)).toBe(2);
    expect(summarizeRsvps(withOrphan, [target], null)[0]?.yesCount).toBe(3);
  });
});

describe("capacityDecision", () => {
  it("is full once the other seat holders reach the capacity", () => {
    expect(capacityDecision(2, 1)).toBe("open");
    expect(capacityDecision(2, 2)).toBe("full");
    expect(capacityDecision(2, 3)).toBe("full");
    expect(capacityDecision(1, 0)).toBe("open");
  });

  it.each([null, undefined, 0, -1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY])(
    "has no limit for capacity %j",
    (capacity) => {
      expect(capacityDecision(capacity, 1_000_000)).toBe("open");
    },
  );
});

describe("stripPrivateUsers", () => {
  const rows = () => [row(1, 8, "yes"), row(2, 9, "no"), row(3, 10, "maybe"), row(4, 5, "no")];
  const users = (list: RsvpRow[]) => list.map((r) => rowUserId(r));

  it("keeps who said yes and the caller's own answer", () => {
    const list = rows();
    stripPrivateUsers(list, { id: 5, role: { type: "member" } });
    expect(users(list)).toEqual([8, null, null, 5]);
    expect(list.map((r) => r.status)).toEqual(["yes", "no", "maybe", "no"]);
  });

  it("strips for editors and callers without an id; admin_role keeps every name", () => {
    const forEditor = rows();
    stripPrivateUsers(forEditor, { id: 77, role: { type: "editor" } });
    expect(users(forEditor)).toEqual([8, null, null, null]);

    const anonymous = rows();
    stripPrivateUsers(anonymous, undefined);
    expect(users(anonymous)).toEqual([8, null, null, null]);

    const forAdmin = rows();
    stripPrivateUsers(forAdmin, { id: 78, role: { type: "admin_role" } });
    expect(users(forAdmin)).toEqual([8, 9, 10, 5]);
  });

  it("deletes the key (not just the value) and skips non-objects", () => {
    const list: unknown[] = [row(2, 9, "no"), null, "x", 3];
    stripPrivateUsers(list, { id: 5, role: { type: "member" } });
    expect(Object.keys(list[0] as object)).not.toContain("user");
    expect(list.slice(1)).toEqual([null, "x", 3]);
  });
});

describe("parseSummaryTargets", () => {
  const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

  it("reads a comma list and repeated params, keeps the order and drops duplicates", () => {
    expect(parseSummaryTargets(`${A},${B}`)).toEqual({ targets: [A, B] });
    expect(parseSummaryTargets([B, `${A},${B}`])).toEqual({ targets: [B, A] });
    expect(parseSummaryTargets(`${A},${A}`)).toEqual({ targets: [A] });
  });

  it.each([
    [undefined, "targets required"],
    [null, "targets required"],
    [[], "targets required"],
    ["", "Invalid targets"],
    [" ", "Invalid targets"],
    [`${A}, ${B}`, "Invalid targets"],
    [`${A},`, "Invalid targets"],
    ["12", "Invalid targets"],
    [A.toUpperCase(), "Invalid targets"],
    ["__proto__", "Invalid targets"],
    [{ 0: A }, "Invalid targets"],
    [[A, 1], "Invalid targets"],
    [42, "Invalid targets"],
  ])("refuses %j", (raw, error) => {
    expect(parseSummaryTargets(raw)).toEqual({ error });
  });

  it(`takes at most ${MAX_SUMMARY_TARGETS} distinct targets`, () => {
    const ids = Array.from(
      { length: MAX_SUMMARY_TARGETS + 1 },
      (_, i) => `t${String(i).padStart(23, "0")}`,
    );
    expect(parseSummaryTargets(ids.slice(0, MAX_SUMMARY_TARGETS).join(","))).toEqual({
      targets: ids.slice(0, MAX_SUMMARY_TARGETS),
    });
    expect(parseSummaryTargets(ids.join(","))).toEqual({
      error: `At most ${MAX_SUMMARY_TARGETS} targets`,
    });
  });
});

/**
 * summarizeRsvps replaces the web's buildRsvpSummaries (WD02). The same
 * cases as its characterisation suite (apps/web/src/lib/event-rsvp.test.ts
 * until the switch), with two deliberate differences: the CMS sees every
 * user, so decliners dedupe per user instead of per row, and every
 * requested target gets a summary.
 */
describe("summarizeRsvps", () => {
  const EVT_A = "evta00000000000000000000";
  const EVT_B = "evtb00000000000000000000";
  let nextId = 1;
  const answer = (
    target: string,
    status: string,
    user: { id: number; displayName?: string } | null,
    respondedAt: string | null = null,
  ): RsvpRow => ({ id: nextId++, targetDocumentId: target, status, respondedAt, user });

  it("counts each bucket, lists the yes names and returns every target in order", () => {
    const [b, a] = summarizeRsvps(
      [
        answer(EVT_A, "yes", { id: 1, displayName: "Ada" }, "2026-09-10T09:00:00.000Z"),
        answer(EVT_A, "yes", { id: 2, displayName: "Grace" }, "2026-09-10T10:00:00.000Z"),
        answer(EVT_A, "maybe", { id: 3, displayName: "Unsure" }),
        answer(EVT_A, "no", { id: 4, displayName: "Decliner" }),
      ],
      [EVT_B, EVT_A],
      null,
    );
    expect(a).toEqual({
      targetDocumentId: EVT_A,
      yesCount: 2,
      maybeCount: 1,
      noCount: 1,
      yesNames: ["Ada", "Grace"],
      myStatus: null,
    });
    expect(b).toEqual({
      targetDocumentId: EVT_B,
      yesCount: 0,
      maybeCount: 0,
      noCount: 0,
      yesNames: [],
      myStatus: null,
    });
  });

  it("collapses a user's duplicate rows to the newest, a tie to the higher id", () => {
    const at = "2026-09-10T10:00:00.000Z";
    const [summary] = summarizeRsvps(
      [
        answer(EVT_A, "yes", { id: 1 }, "2026-09-10T09:00:00.000Z"),
        answer(EVT_A, "no", { id: 1 }, "2026-09-10T11:00:00.000Z"),
        answer(EVT_A, "no", { id: 2, displayName: "Grace" }, at),
        answer(EVT_A, "yes", { id: 2, displayName: "Grace" }, at),
        answer(EVT_A, "maybe", { id: 3 }, null),
        answer(EVT_A, "yes", { id: 3 }, "2026-01-01T00:00:00.000Z"),
      ],
      [EVT_A],
      null,
    );
    expect(summary).toMatchObject({ yesCount: 2, maybeCount: 0, noCount: 1, yesNames: ["Grace"] });
  });

  it("dedupes decliners per user (the web could only count their stripped rows)", () => {
    const [summary] = summarizeRsvps(
      [
        answer(EVT_A, "no", { id: 4 }),
        answer(EVT_A, "no", { id: 4 }),
        answer(EVT_A, "maybe", { id: 5 }),
      ],
      [EVT_A],
      null,
    );
    expect(summary).toMatchObject({ maybeCount: 1, noCount: 1 });
  });

  it("counts every row whose user is gone on its own, without a name", () => {
    const [summary] = summarizeRsvps(
      [answer(EVT_A, "yes", null), answer(EVT_A, "yes", null), answer(EVT_A, "no", null)],
      [EVT_A],
      7,
    );
    expect(summary).toMatchObject({ yesCount: 2, noCount: 1, yesNames: [], myStatus: null });
  });

  it("derives myStatus from the caller's newest row only", () => {
    const [summary] = summarizeRsvps(
      [
        answer(EVT_A, "yes", { id: 7, displayName: "Me" }, "2026-09-10T10:00:00.000Z"),
        answer(EVT_A, "maybe", { id: 7, displayName: "Me" }, "2026-09-10T12:00:00.000Z"),
        answer(EVT_A, "yes", { id: 1, displayName: "Ada" }, "2026-09-10T13:00:00.000Z"),
      ],
      [EVT_A],
      7,
    );
    expect(summary).toMatchObject({ myStatus: "maybe", yesNames: ["Ada"], maybeCount: 1 });
    expect(
      summarizeRsvps([answer(EVT_A, "yes", { id: 7 })], [EVT_A], null)[0]?.myStatus,
    ).toBeNull();
  });

  it("ignores rows of other targets and rows with an unknown status", () => {
    const [summary] = summarizeRsvps(
      [
        answer(EVT_B, "yes", { id: 1, displayName: "Ada" }),
        answer(EVT_A, "attending", { id: 2 }),
        { id: 99, status: "yes", user: { id: 3 } },
      ],
      [EVT_A],
      null,
    );
    expect(summary).toMatchObject({ yesCount: 0, maybeCount: 0, noCount: 0, yesNames: [] });
  });

  it("names a yes only with a non-empty display name", () => {
    const [summary] = summarizeRsvps(
      [answer(EVT_A, "yes", { id: 1, displayName: "" }), answer(EVT_A, "yes", { id: 2 })],
      [EVT_A],
      null,
    );
    expect(summary).toMatchObject({ yesCount: 2, yesNames: [] });
  });
});

describe("filtersReferenceUser", () => {
  it.each([
    { user: 7 },
    { user: { id: { $eq: 7 } } },
    { status: "no", user: { displayName: { $startsWith: "A" } } },
    { $or: [{ status: "no" }, { user: { id: 7 } }] },
    { $and: [{ $or: [{ $not: { user: { id: 7 } } }] }] },
    { $or: { 0: { status: "no" }, 30: { user: { id: 7 } } } },
    [{ user: { id: 7 } }],
    { "user.id": 7 },
  ])("finds the user relation in %j", (filters) => {
    expect(filtersReferenceUser(filters)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "user",
    7,
    {},
    { status: "no" },
    { targetDocumentId: { $eq: "user" } },
    { $or: [{ status: "no" }, { respondedAt: { $null: true } }] },
    { users: 7 },
    { username: "x" },
  ])("finds none in %j", (filters) => {
    expect(filtersReferenceUser(filters)).toBe(false);
  });

  it("terminates on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { status: "no" };
    cyclic.$and = [cyclic];
    expect(filtersReferenceUser(cyclic)).toBe(false);
  });
});

describe("requestsLegacyFormat", () => {
  it.each([
    [{ "strapi-response-format": "v4" }, true],
    [{ "strapi-response-format": "V4" }, true],
    [{ "strapi-response-format": " v5 " }, true],
    [{ "strapi-response-format": ["v4"] }, true],
    [{ "strapi-response-format": "" }, false],
    [{ "strapi-response-format": "  " }, false],
    [{ "strapi-response-format": [] }, false],
    [{ accept: "application/json" }, false],
    [{}, false],
    [undefined, false],
    [null, false],
  ])("reads %j as %s", (headers, expected) => {
    expect(requestsLegacyFormat(headers)).toBe(expected);
  });
});
