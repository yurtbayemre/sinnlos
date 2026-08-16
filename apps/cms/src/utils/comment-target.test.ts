import { describe, expect, it } from "vitest";
import {
  WRITE_TARGET_ERRORS,
  anchorFromTargetRow,
  findCommentTarget,
  isCommentTargetType,
  legacyTargetId,
  planAnchorBackfill,
  resolveWriteTarget,
  targetAnchor,
  targetMatchWhere,
  targetUid,
  type AnchorableRow,
} from "./comment-target";

/**
 * Anchor resolution + backfill decision for comments and reactions
 * (GitHub issue #11).
 *
 * Both target types are draftAndPublish and Strapi 5 publishes by
 * delete-then-recreate, so the numeric row id a comment used to point at is
 * gone after the next "Publish" click. These tests pin the three things the
 * migration hinges on:
 *   1. the anchor is the documentId, resolved published-row-first, and an
 *      anchored row NEVER falls back to the stale numeric id,
 *   2. the backfill decision is idempotent (anchored rows are skipped) and
 *      never guesses (missing target / unusable row → skip, keep the legacy
 *      id, warn),
 *   3. the temporary legacy read branch only ever matches UNANCHORED rows,
 *      so a recycled row id cannot drag a foreign discussion into a target,
 *   4. the temporary write bridge: a payload with only the deprecated
 *      `targetId` (old web container, partial rollback) still produces a
 *      correctly anchored row, and every write dual-writes both keys so a
 *      FULL rollback to the id-only code still sees the new rows.
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

describe("legacyTargetId", () => {
  it("accepts positive integers and their string form", () => {
    expect(legacyTargetId(42)).toBe(42);
    expect(legacyTargetId(" 42 ")).toBe(42);
  });

  it("rejects everything that is not a usable row id", () => {
    for (const value of [0, -1, 1.5, "abc", "", null, undefined, {}]) {
      expect(legacyTargetId(value)).toBeNull();
    }
  });
});

describe("planAnchorBackfill", () => {
  it("skips rows that already carry an anchor (idempotent re-runs)", () => {
    const row: AnchorableRow = {
      id: 1,
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
      targetId: 7,
    };
    expect(planAnchorBackfill(row)).toEqual({ action: "skip", reason: "already-anchored" });
  });

  it("treats a blank anchor as missing and still migrates the row", () => {
    const row: AnchorableRow = {
      id: 1,
      targetType: "announcement",
      targetDocumentId: "   ",
      targetId: 7,
    };
    expect(planAnchorBackfill(row)).toEqual({
      action: "resolve",
      uid: "api::announcement.announcement",
      legacyTargetId: 7,
    });
  });

  it("resolves the wiki-page branch against the wiki-page uid", () => {
    expect(planAnchorBackfill({ id: 2, targetType: "wiki-page", targetId: 3 })).toEqual({
      action: "resolve",
      uid: "api::wiki-page.wiki-page",
      legacyTargetId: 3,
    });
  });

  it("skips rows with an unknown targetType instead of guessing a uid", () => {
    expect(planAnchorBackfill({ id: 3, targetType: "document", targetId: 9 })).toEqual({
      action: "skip",
      reason: "unknown-target-type",
    });
  });

  it("skips rows without a usable legacy id — nothing left to resolve from", () => {
    expect(planAnchorBackfill({ id: 4, targetType: "announcement", targetId: null })).toEqual({
      action: "skip",
      reason: "no-legacy-id",
    });
    expect(planAnchorBackfill(null)).toEqual({ action: "skip", reason: "unknown-target-type" });
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
  it("matches by anchor alone when no legacy id is known", () => {
    expect(targetMatchWhere("announcement", ANNOUNCEMENT_DOC)).toEqual({
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
    expect(targetMatchWhere("announcement", ANNOUNCEMENT_DOC, null)).toEqual({
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
    });
  });

  it("adds the legacy branch guarded by 'targetDocumentId IS NULL'", () => {
    expect(targetMatchWhere("wiki-page", WIKI_DOC, 12)).toEqual({
      targetType: "wiki-page",
      $or: [{ targetDocumentId: WIKI_DOC }, { targetDocumentId: { $null: true }, targetId: 12 }],
    });
  });

  /**
   * The dual-write (`resolveWriteTarget`) stores BOTH keys on every new row,
   * so the guard is what keeps the two branches disjoint. Evaluated against
   * real rows, not just the clause shape.
   */
  describe("evaluated against rows", () => {
    const rows = [
      // Written by the current code: anchor + dual-written row id.
      { id: 1, targetType: "announcement", targetDocumentId: ANNOUNCEMENT_DOC, targetId: 91 },
      // Written before the anchor existed, backfill has not reached it yet.
      { id: 2, targetType: "announcement", targetDocumentId: null, targetId: 91 },
      // Foreign entry that owns row id 91 now (publish = delete+recreate).
      { id: 3, targetType: "announcement", targetDocumentId: WIKI_DOC, targetId: 91 },
      { id: 4, targetType: "announcement", targetDocumentId: null, targetId: 92 },
      { id: 5, targetType: "wiki-page", targetDocumentId: ANNOUNCEMENT_DOC, targetId: 91 },
    ];
    const matching = (where: Record<string, unknown>) =>
      rows.filter((row) => whereMatches(row, where)).map((row) => row.id);

    it("matches the target's rows and neither the foreign nor the wiki-page row", () => {
      expect(matching(targetMatchWhere("announcement", ANNOUNCEMENT_DOC, 91))).toEqual([1, 2]);
    });

    it("matches a dual-written row through the ANCHOR branch only, never twice", () => {
      const where = targetMatchWhere("announcement", ANNOUNCEMENT_DOC, 91);
      const [anchorBranch, legacyBranch] = where.$or as Record<string, unknown>[];
      // Row 1 carries anchor AND targetId 91 — the guard keeps it out of the
      // legacy branch, so it can never be counted/loaded twice.
      expect(matching({ targetType: "announcement", ...anchorBranch })).toEqual([1]);
      expect(matching({ targetType: "announcement", ...legacyBranch })).toEqual([2]);
    });

    it("drops the legacy branch entirely once no legacy id is known", () => {
      expect(matching(targetMatchWhere("announcement", ANNOUNCEMENT_DOC))).toEqual([1]);
    });
  });
});

/**
 * Minimal `where` evaluator with the operators used here: `$or` (array of
 * sub-clauses), `$null` / `$notNull`, everything else exact equality. Several
 * keys in one object are an implicit AND — exactly the semantics
 * `targetMatchWhere` relies on for its guarded legacy branch.
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

  it("never falls back to the stale numeric id once a row is anchored", async () => {
    // Row 91 now belongs to a DIFFERENT document (ids are recycled by
    // delete+recreate) — resolving it would attach the comment to it.
    const strapi = stubStrapi({
      "api::announcement.announcement": [
        { id: 91, documentId: WIKI_DOC, publishedAt: "2026-08-02T10:00:00.000Z" },
      ],
    });
    const target = await findCommentTarget(strapi, {
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
      targetId: 91,
    });
    expect(target).toBeNull();
  });

  it("resolves an unanchored legacy row by its numeric id (temporary bridge)", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [publishedAnnouncement] });
    const target = await findCommentTarget(strapi, {
      targetType: "announcement",
      targetDocumentId: null,
      targetId: 91,
    });
    expect(target?.documentId).toBe(ANNOUNCEMENT_DOC);
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

  it("returns null without querying for unknown target types or missing keys", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [publishedAnnouncement] });
    expect(await findCommentTarget(strapi, { targetType: "document", targetId: 91 })).toBeNull();
    expect(await findCommentTarget(strapi, { targetType: "announcement" })).toBeNull();
    expect(strapi.calls).toHaveLength(0);
  });
});

/**
 * The write path (issue #11): dual-write + write bridge, both TEMPORARY until
 * the follow-up ticket removes the `targetId` column.
 *
 * Dual-write exists for the rollback: the id-only code filters on `targetId`
 * alone, so a row written without it would be invisible after a full
 * rollback. The bridge exists for the PARTIAL rollback (old web container,
 * new CMS — the example in infra/deploy.sh): that web sends only `targetId`,
 * and rejecting it would kill every comment and every reaction.
 */
describe("resolveWriteTarget", () => {
  const foreignAnnouncement = {
    id: 77,
    documentId: WIKI_DOC,
    publishedAt: "2026-08-03T10:00:00.000Z",
  };

  it("dual-writes anchor + the published row id (rollback anchor)", async () => {
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
      targetId: 91,
    });
  });

  it("falls back to the draft row id while the target is unpublished", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [draftAnnouncement] });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetDocumentId: ANNOUNCEMENT_DOC,
      }),
    ).toMatchObject({ status: "ok", targetDocumentId: ANNOUNCEMENT_DOC, targetId: 90 });
  });

  it("bridges a legacy targetId-only payload to the anchor (old web, new CMS)", async () => {
    const strapi = stubStrapi({
      "api::announcement.announcement": [draftAnnouncement, publishedAnnouncement],
    });
    expect(await resolveWriteTarget(strapi, { targetType: "announcement", targetId: 91 })).toEqual({
      status: "ok",
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
      targetId: 91,
    });
  });

  it("accepts the numeric string form an API caller may send", async () => {
    const strapi = stubStrapi({ "api::wiki-page.wiki-page": [{ id: 5, documentId: WIKI_DOC }] });
    expect(await resolveWriteTarget(strapi, { targetType: "wiki-page", targetId: " 5 " })).toEqual({
      status: "ok",
      targetType: "wiki-page",
      targetDocumentId: WIKI_DOC,
      targetId: 5,
    });
  });

  it("bridges a DRAFT row id to the published row id, not the one it was sent", async () => {
    // The rolled-back code filters on the published row id, so the bridge has
    // to canonicalise instead of storing whatever id came in.
    const strapi = stubStrapi({
      "api::announcement.announcement": [draftAnnouncement, publishedAnnouncement],
    });
    expect(await resolveWriteTarget(strapi, { targetType: "announcement", targetId: 90 })).toEqual({
      status: "ok",
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
      targetId: 91,
    });
  });

  it("lets the anchor win over a stale targetId in the same payload", async () => {
    const strapi = stubStrapi({
      "api::announcement.announcement": [publishedAnnouncement, foreignAnnouncement],
    });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetDocumentId: ANNOUNCEMENT_DOC,
        targetId: 77,
      }),
    ).toEqual({
      status: "ok",
      targetType: "announcement",
      targetDocumentId: ANNOUNCEMENT_DOC,
      targetId: 91,
    });
    // Never looked the client's row id up — it cannot redirect the write.
    expect(strapi.calls.some((call) => "id" in call.where)).toBe(false);
  });

  it("rejects an unknown targetType without touching the database", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [publishedAnnouncement] });
    expect(await resolveWriteTarget(strapi, { targetType: "document", targetId: 91 })).toEqual({
      status: "rejected",
      reason: "invalid-target-type",
    });
    expect(strapi.calls).toHaveLength(0);
  });

  it("rejects a payload with neither key — including blank/unusable values", async () => {
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

  it("rejects an anchor or a legacy id that resolves to nothing", async () => {
    const strapi = stubStrapi({ "api::announcement.announcement": [] });
    expect(
      await resolveWriteTarget(strapi, {
        targetType: "announcement",
        targetDocumentId: ANNOUNCEMENT_DOC,
      }),
    ).toEqual({ status: "rejected", reason: "unresolved-target" });
    expect(await resolveWriteTarget(strapi, { targetType: "announcement", targetId: 91 })).toEqual({
      status: "rejected",
      reason: "unresolved-target",
    });
  });

  it("answers 'missing' and 'unresolved' identically — no documentId oracle", () => {
    expect(WRITE_TARGET_ERRORS["unresolved-target"]).toBe(WRITE_TARGET_ERRORS["missing-target"]);
  });
});
