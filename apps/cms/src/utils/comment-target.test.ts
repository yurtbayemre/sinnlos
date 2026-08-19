import { describe, expect, it } from "vitest";
import {
  WRITE_TARGET_ERRORS,
  anchorFromTargetRow,
  findCommentTarget,
  isCommentTargetType,
  resolveWriteTarget,
  targetAnchor,
  targetMatchWhere,
  targetUid,
  type AnchorableRow,
} from "./comment-target";

/**
 * Anchor resolution for comments and reactions (GitHub issue #11, bridge
 * removed with #25).
 *
 * Both target types are draftAndPublish and Strapi 5 publishes by
 * delete-then-recreate, so the numeric row id a comment used to point at is
 * gone after the next "Publish" click. These tests pin the two things the
 * anchoring hinges on:
 *   1. the anchor is the documentId, resolved published-row-first, and a row
 *      id is NEVER looked up — not even when a client still sends the
 *      removed legacy `targetId`,
 *   2. an unanchored row (`targetDocumentId IS NULL`) never matches and a
 *      targetId-only payload is rejected without touching the database
 *      (regression pins for the #25 bridge removal).
 *
 * Pure logic plus a db.query stub — no Strapi runtime, no database.
 */

const ANNOUNCEMENT_DOC = "a1b2c3d4e5f6g7h8i9j0kl";
const WIKI_DOC = "z9y8x7w6v5u4t3s2r1q0po";

describe("targetUid / isCommentTargetType", () => {
  it("maps both target branches to their content-type uid", () => {
    expect(targetUid("announcement")).toBe("api::announcement.announcement");
    expect(targetUid("wiki-page")).toBe("api::wiki-page.wiki-page");
  });

  it("rejects unknown, empty and non-string target types", () => {
    for (const value of ["document", "", null, undefined, 7, {}]) {
      expect(isCommentTargetType(value)).toBe(false);
      expect(targetUid(value)).toBeNull();
    }
  });
});

describe("targetAnchor", () => {
  it("accepts a non-empty documentId and trims it", () => {
    expect(targetAnchor(ANNOUNCEMENT_DOC)).toBe(ANNOUNCEMENT_DOC);
    expect(targetAnchor(`  ${ANNOUNCEMENT_DOC} `)).toBe(ANNOUNCEMENT_DOC);
  });

  it("treats blank and non-string values as 'no anchor'", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      expect(targetAnchor(value)).toBeNull();
    }
  });
});

describe("anchorFromTargetRow", () => {
  it("returns the documentId of the resolved target", () => {
    expect(anchorFromTargetRow({ documentId: ANNOUNCEMENT_DOC })).toBe(ANNOUNCEMENT_DOC);
  });

  it("returns null when the target row is gone — the caller must skip, not guess", () => {
    expect(anchorFromTargetRow(null)).toBeNull();
    expect(anchorFromTargetRow(undefined)).toBeNull();
    expect(anchorFromTargetRow({})).toBeNull();
    expect(anchorFromTargetRow({ documentId: "" })).toBeNull();
  });
});

describe("targetMatchWhere", () => {
  it("matches by the anchor pair alone", () => {
    expect(targetMatchWhere("announcement", ANNOUNCEMENT_DOC)).toEqual({
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
  });

  /**
   * Evaluated against real rows, not just the clause shape: only anchored
   * rows of the target match — foreign documents, the other targetType and
   * unanchored rows never do (#25 removed the legacy targetId branch).
   */
  describe("evaluated against rows", () => {
    const rows = [
      // Anchored row of the target.
      { id: 1, targetType: "announcement", targetDocumentId: ANNOUNCEMENT_DOC },
      // Unanchored pre-#11 row — must NEVER match since #25.
      { id: 2, targetType: "announcement", targetDocumentId: null },
      // Anchored row of a foreign document.
      { id: 3, targetType: "announcement", targetDocumentId: WIKI_DOC },
      // Same documentId but the other targetType.
      { id: 4, targetType: "wiki-page", targetDocumentId: ANNOUNCEMENT_DOC },
    ];
    const matching = (where: Record<string, unknown>) =>
      rows.filter((row) => whereMatches(row, where)).map((row) => row.id);

    it("matches only the anchored rows of the target", () => {
      expect(matching(targetMatchWhere("announcement", ANNOUNCEMENT_DOC))).toEqual([1]);
    });

    it("never matches a row with targetDocumentId null (#25 regression pin)", () => {
      const where = targetMatchWhere("announcement", ANNOUNCEMENT_DOC);
      expect(whereMatches(rows[1], where)).toBe(false);
    });
  });
});

/**
 * Minimal `where` evaluator with the operators used here: `$or` (array of
 * sub-clauses), `$null` / `$notNull`, everything else exact equality. Several
 * keys in one object are an implicit AND.
 */
function whereMatches(row: any, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Record<string, unknown>[]).some((clause) => whereMatches(row, clause));
    }
    if (condition && typeof condition === "object") {
      const op = condition as Record<string, unknown>;
      if ("$notNull" in op) return op.$notNull ? row[key] != null : row[key] == null;
      if ("$null" in op) return op.$null ? row[key] == null : row[key] != null;
    }
    return row[key] === condition;
  });
}

/** db.query stub: one table per uid, `where` evaluated by `whereMatches`. */
function stubStrapi(tables: Record<string, any[]>) {
  const calls: { uid: string; where: Record<string, unknown> }[] = [];
  return {
    calls,
    db: {
      query: (uid: string) => ({
        async findOne({ where }: any) {
          calls.push({ uid, where });
          return (tables[uid] ?? []).find((row) => whereMatches(row, where)) ?? null;
        },
      }),
    },
  };
}

const publishedAnnouncement = {
  id: 91,
  documentId: ANNOUNCEMENT_DOC,
  publishedAt: "2026-08-01T10:00:00.000Z",
  title: "published",
};
const draftAnnouncement = {
  id: 90,
  documentId: ANNOUNCEMENT_DOC,
  publishedAt: null,
  title: "draft",
};

describe("findCommentTarget", () => {
  it("prefers the published row — a documentId matches draft AND published", async () => {
    const strapi = stubStrapi({
      "api::announcement.announcement": [draftAnnouncement, publishedAnnouncement],
    });
    const target = await findCommentTarget(strapi, {
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
    expect(target?.id).toBe(91);
  });

  it("falls back to the draft row when the target is currently unpublished", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [draftAnnouncement] });
    const target = await findCommentTarget(strapi, {
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
    expect(target?.id).toBe(90);
  });

  it("returns null when the anchor resolves to nothing — never looks a row id up", async () => {
    // Row 91 exists but belongs to a DIFFERENT document (ids are recycled by
    // delete+recreate) — an id lookup would attach the comment to it.
    const strapi = stubStrapi({
      "api::announcement.announcement": [
        { id: 91, documentId: WIKI_DOC, publishedAt: "2026-08-02T10:00:00.000Z" },
      ],
    });
    const target = await findCommentTarget(strapi, {
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
    expect(target).toBeNull();
    expect(strapi.calls.every((call) => !("id" in call.where))).toBe(true);
  });

  it("resolves the wiki-page branch from its own table", async () => {
    const strapi = stubStrapi({
      "api::announcement.announcement": [publishedAnnouncement],
      "api::wiki-page.wiki-page": [
        { id: 5, documentId: WIKI_DOC, publishedAt: "2026-08-01T10:00:00.000Z" },
      ],
    });
    const target = await findCommentTarget(strapi, {
      targetType: "wiki-page",
      targetDocumentId: WIKI_DOC,
    });
    expect(target?.id).toBe(5);
    expect(strapi.calls.every((call) => call.uid === "api::wiki-page.wiki-page")).toBe(true);
  });

  it("returns null without querying for unknown target types or missing anchors", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [publishedAnnouncement] });
    expect(
      await findCommentTarget(strapi, { targetType: "document", targetDocumentId: WIKI_DOC }),
    ).toBeNull();
    expect(await findCommentTarget(strapi, { targetType: "announcement" })).toBeNull();
    expect(strapi.calls).toHaveLength(0);
  });
});

/**
 * The write path: anchor-only since #25. A targetId-only payload — the old
 * partial-rollback bridge — is now rejected with `missing-target` (400), and
 * a `targetId` sent alongside a valid anchor is ignored (no id lookup, so a
 * stale/foreign id cannot redirect the write).
 */
describe("resolveWriteTarget", () => {
  const foreignAnnouncement = {
    id: 77,
    documentId: WIKI_DOC,
    publishedAt: "2026-08-03T10:00:00.000Z",
  };

  it("resolves the anchor pair, published row preferred", async () => {
    const strapi = stubStrapi({
      "api::announcement.announcement": [draftAnnouncement, publishedAnnouncement],
    });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetDocumentId: ANNOUNCEMENT_DOC,
      }),
    ).toEqual({
      status: "ok",
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
  });

  it("accepts a target that only exists as a draft", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [draftAnnouncement] });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetDocumentId: ANNOUNCEMENT_DOC,
      }),
    ).toEqual({
      status: "ok",
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
  });

  it("rejects a payload with ONLY the removed legacy targetId — no DB query (#25)", async () => {
    const strapi = stubStrapi({
      "api::announcement.announcement": [draftAnnouncement, publishedAnnouncement],
    });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetId: 91,
      } as AnchorableRow),
    ).toEqual({ status: "rejected", reason: "missing-target" });
    expect(strapi.calls).toHaveLength(0);
  });

  it("ignores a stale targetId sent alongside a valid anchor — no id lookup (#25)", async () => {
    const strapi = stubStrapi({
      "api::announcement.announcement": [publishedAnnouncement, foreignAnnouncement],
    });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetDocumentId: ANNOUNCEMENT_DOC,
        targetId: 77,
      } as AnchorableRow),
    ).toEqual({
      status: "ok",
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
    // Never looked the client's row id up — it cannot redirect the write.
    expect(strapi.calls.some((call) => "id" in call.where)).toBe(false);
  });

  it("rejects an unknown targetType without touching the database", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [publishedAnnouncement] });
    expect(
      await resolveWriteTarget(strapi, { targetType: "document", targetDocumentId: WIKI_DOC }),
    ).toEqual({
      status: "rejected",
      reason: "invalid-target-type",
    });
    expect(strapi.calls).toHaveLength(0);
  });

  it("rejects a payload without a usable anchor — including blank values", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [publishedAnnouncement] });
    for (const payload of [
      { targetType: "announcement" },
      { targetType: "announcement", targetDocumentId: "   ", targetId: 0 },
    ] as AnchorableRow[]) {
      expect(await resolveWriteTarget(strapi, payload)).toEqual({
        status: "rejected",
        reason: "missing-target",
      });
    }
    expect(strapi.calls).toHaveLength(0);
  });

  it("rejects an anchor that resolves to nothing", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [] });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetDocumentId: ANNOUNCEMENT_DOC,
      }),
    ).toEqual({ status: "rejected", reason: "unresolved-target" });
  });

  it("answers 'missing' and 'unresolved' identically — no documentId oracle", () => {
    expect(WRITE_TARGET_ERRORS["unresolved-target"]).toBe(WRITE_TARGET_ERRORS["missing-target"]);
  });
});
