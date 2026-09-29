import { describe, expect, it } from "vitest";

import { matchWhere } from "../test/strapi-stub.test.helper";
import { isAnnouncementExpired, notExpiredWhere } from "./announcement-expiry";

/**
 * DA02: an announcement is expired from its `expiresAt` instant on. The
 * in-memory rule and the query-engine where must agree (the list policy and
 * the digest filter in SQL, the comment-target check in memory).
 */

const NOW = new Date("2026-09-29T10:00:00.000Z");

const ROWS: Array<{ id: number; expiresAt?: unknown }> = [
  { id: 1, expiresAt: null },
  { id: 2 },
  { id: 3, expiresAt: "2026-09-29T09:59:59.999Z" },
  { id: 4, expiresAt: "2026-09-29T10:00:00.000Z" },
  { id: 5, expiresAt: "2026-09-29T10:00:00.001Z" },
  { id: 6, expiresAt: "2027-01-01T00:00:00.000Z" },
  { id: 7, expiresAt: "2020-01-01T00:00:00.000Z" },
];

describe("isAnnouncementExpired", () => {
  it("is expired from the expiresAt instant on, never without one", () => {
    expect(ROWS.filter((row) => isAnnouncementExpired(row, NOW)).map((row) => row.id)).toEqual([
      3, 4, 7,
    ]);
  });

  it("reads Date values and offset instants alike", () => {
    expect(isAnnouncementExpired({ expiresAt: new Date("2026-09-29T09:00:00Z") }, NOW)).toBe(true);
    // 12:00 in Berlin (UTC+2 in September) is 10:00 UTC: expired at NOW.
    expect(isAnnouncementExpired({ expiresAt: "2026-09-29T12:00:00+02:00" }, NOW)).toBe(true);
    expect(isAnnouncementExpired({ expiresAt: "2026-09-29T12:00:01+02:00" }, NOW)).toBe(false);
  });

  it("counts an unreadable value as not expired (targeting still applies)", () => {
    for (const expiresAt of ["soon", "", 1_700_000_000_000, {}, "2026-02-30T00:00:00Z"]) {
      expect(isAnnouncementExpired({ expiresAt }, NOW), String(expiresAt)).toBe(false);
    }
  });
});

describe("notExpiredWhere", () => {
  it("selects exactly the rows the in-memory rule keeps", () => {
    const uid = "api::announcement.announcement";
    const kept = ROWS.filter((row) => matchWhere(uid, row, notExpiredWhere(NOW)));
    expect(kept.map((row) => row.id)).toEqual(
      ROWS.filter((row) => !isAnnouncementExpired(row, NOW)).map((row) => row.id),
    );
  });

  it("compares with the instant as ISO-Z", () => {
    expect(notExpiredWhere(NOW)).toEqual({
      $or: [{ expiresAt: { $null: true } }, { expiresAt: { $gt: "2026-09-29T10:00:00.000Z" } }],
    });
  });
});
