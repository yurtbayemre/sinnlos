import { describe, expect, it } from "vitest";
import {
  anchorOf,
  legacyIdOf,
  matchesTarget,
  targetFilterQuery,
  type CommentTarget,
} from "./comment-target";

/**
 * Addressing a comment section / reaction bar by the target's documentId
 * (GitHub issue #11).
 *
 * Announcements and wiki pages are draftAndPublish, and Strapi 5 publishes by
 * delete-then-recreate: the numeric row id these rows used to be anchored to
 * changes with every publish, so a re-published announcement lost all its
 * comments and reactions. These tests pin
 *   1. the query really filters by the anchor,
 *   2. the TEMPORARY legacy branch only matches rows that carry NO anchor —
 *      otherwise a recycled row id would drag a foreign discussion in, and
 *   3. the same rule applied to the fetched rows (`matchesTarget`), which is
 *      what keeps the reaction counts honest.
 */

const DOC = "a1b2c3d4e5f6g7h8i9j0kl";
const OTHER_DOC = "z9y8x7w6v5u4t3s2r1q0po";

const target = (over: Partial<CommentTarget> = {}): CommentTarget => ({
  type: "announcement",
  documentId: DOC,
  id: 42,
  ...over,
});

describe("anchorOf / legacyIdOf", () => {
  it("accepts a non-empty documentId and trims it", () => {
    expect(anchorOf(` ${DOC} `)).toBe(DOC);
  });

  it("treats blank and non-string documentIds as 'no anchor'", () => {
    for (const value of ["", "  ", null, undefined, 7]) expect(anchorOf(value)).toBeNull();
  });

  it("accepts only positive integer row ids", () => {
    expect(legacyIdOf(42)).toBe(42);
    expect(legacyIdOf("42")).toBe(42);
    for (const value of [0, -3, 1.5, "", "x", null, undefined]) {
      expect(legacyIdOf(value)).toBeNull();
    }
  });
});

describe("targetFilterQuery", () => {
  it("filters by targetType plus the documentId anchor", () => {
    const query = targetFilterQuery(target({ id: null }));
    expect(query).toBe(
      `filters[targetType][$eq]=announcement&filters[targetDocumentId][$eq]=${DOC}`,
    );
  });

  it("ORs in the legacy row id, guarded by 'anchor IS NULL'", () => {
    const query = targetFilterQuery(target())!;
    expect(query).toContain("filters[targetType][$eq]=announcement");
    expect(query).toContain(`filters[$or][0][targetDocumentId][$eq]=${DOC}`);
    // The guard is what stops an ANCHORED row of another entry from matching
    // once a re-publish hands its old numeric id to a different row.
    expect(query).toContain("filters[$or][1][targetDocumentId][$null]=true");
    expect(query).toContain("filters[$or][1][targetId][$eq]=42");
  });

  it("keeps the legacy conditions in ONE $or element (qs depth limit)", () => {
    // Strapi's qs parser stops at depth 5: an explicit
    // filters[$or][1][$and][0][targetDocumentId][$null] is one level too deep
    // and gets rejected by validateQuery. Two keys in the same object are an
    // implicit AND and stay within the limit.
    expect(targetFilterQuery(target())).not.toContain("$and");
  });

  it("falls back to the legacy id alone when the anchor is missing", () => {
    expect(targetFilterQuery(target({ documentId: null }))).toBe(
      "filters[targetType][$eq]=announcement&filters[targetDocumentId][$null]=true&filters[targetId][$eq]=42",
    );
  });

  it("returns null when neither anchor is usable — never query unfiltered", () => {
    expect(targetFilterQuery({ type: "announcement" })).toBeNull();
    expect(targetFilterQuery({ type: "wiki-page", documentId: "  ", id: 0 })).toBeNull();
  });

  it("url-encodes the documentId", () => {
    expect(targetFilterQuery({ type: "wiki-page", documentId: "a b&c" })).toContain(
      "filters[targetDocumentId][$eq]=a%20b%26c",
    );
  });
});

describe("matchesTarget", () => {
  it("matches an anchored row by its anchor", () => {
    expect(matchesTarget({ targetType: "announcement", targetDocumentId: DOC }, target())).toBe(
      true,
    );
  });

  it("rejects an anchored row of a different entry even if the row id matches", () => {
    // The exact re-publish trap: announcement B now owns row id 42, while
    // this comment belongs to document A.
    expect(
      matchesTarget(
        { targetType: "announcement", targetDocumentId: OTHER_DOC, targetId: 42 },
        target(),
      ),
    ).toBe(false);
  });

  it("matches an unanchored legacy row by its row id (temporary bridge)", () => {
    expect(
      matchesTarget({ targetType: "announcement", targetDocumentId: null, targetId: 42 }, target()),
    ).toBe(true);
  });

  it("rejects an unanchored row with a different row id", () => {
    expect(matchesTarget({ targetType: "announcement", targetId: 43 }, target())).toBe(false);
  });

  it("rejects an unanchored row when the target has no legacy id either", () => {
    expect(matchesTarget({ targetType: "announcement", targetId: 42 }, target({ id: null }))).toBe(
      false,
    );
  });

  it("keeps the two targetType branches apart", () => {
    const row = { targetType: "wiki-page", targetDocumentId: DOC };
    expect(matchesTarget(row, target())).toBe(false);
    expect(matchesTarget(row, target({ type: "wiki-page" }))).toBe(true);
  });

  /**
   * Since the dual-write (issue #11) the CMS stores the anchor AND the
   * target's current row id on every new row, so the "anchored rows are
   * matched by their anchor only" rule is what keeps them from being counted
   * through both branches.
   */
  it("matches a dual-written row by its anchor only, exactly once", () => {
    const rows = [
      { targetType: "announcement", targetDocumentId: DOC, targetId: 42 }, // dual-written
      { targetType: "announcement", targetDocumentId: null, targetId: 42 }, // not backfilled
      { targetType: "announcement", targetDocumentId: OTHER_DOC, targetId: 42 }, // foreign
    ];
    expect(rows.filter((row) => matchesTarget(row, target()))).toEqual([rows[0], rows[1]]);
    // The anchor decides even when the dual-written id is stale (the target
    // was re-published since and now owns a different row id).
    expect(matchesTarget(rows[0], target({ id: 43 }))).toBe(true);
  });
});
