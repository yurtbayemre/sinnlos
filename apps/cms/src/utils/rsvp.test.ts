import { describe, expect, it } from "vitest";
import {
  RSVP_STATUSES,
  capacityDecision,
  compareNewestFirst,
  distinctYesUsers,
  isRsvpStatus,
  newestFirst,
  pickSurvivor,
  rowUserId,
  stripPrivateUsers,
  type RsvpRow,
} from "./rsvp";

/**
 * Pure RSVP rules (FX21). The controller suite (event-rsvp.test.ts) pins
 * them through the upsert, the capacity gate and the read filter; these pin
 * the rules themselves, including the healing order and distinct-user
 * capacity.
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

describe("distinctYesUsers", () => {
  it("counts users, not rows", () => {
    expect(
      distinctYesUsers([row(1, 8, "yes"), row(2, 8, "yes"), row(3, 9, "yes"), row(4, 10, "no")]),
    ).toBe(2);
  });

  it("never counts the excluded caller, and ignores rows without a user", () => {
    const rows = [row(1, 8, "yes"), row(2, 5, "yes"), row(3, null, "yes")];
    expect(distinctYesUsers(rows, 5)).toBe(1);
    expect(distinctYesUsers(rows)).toBe(2);
    expect(distinctYesUsers(rows, null)).toBe(2);
  });

  it("counts yes rows only", () => {
    expect(distinctYesUsers([row(1, 8, "maybe"), row(2, 9, "no")])).toBe(0);
  });
});

describe("capacityDecision", () => {
  it("is full once the other distinct yes users reach the capacity", () => {
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
