import { describe, expect, it } from "vitest";

import {
  COMMENT_TARGET_TYPES,
  anchorFromTargetRow,
  isCommentTargetType,
  matchesTarget,
  targetAnchor,
  targetFilterQuery,
  targetMatchWhere,
  type CommentTarget,
} from "./comment-target.js";

/**
 * Addressing a comment section / reaction bar by the target's documentId
 * (GitHub issue #11; the legacy targetId bridge was removed with #25).
 *
 * Announcements and wiki pages are draftAndPublish, and Strapi 5 publishes by
 * delete-then-recreate: the numeric row id these rows used to be anchored to
 * changes with every publish, so a re-published announcement lost all its
 * comments and reactions. These tests pin
 *   1. the query filters by targetType + documentId anchor and NOTHING else,
 *   2. the same rule applied to the fetched rows (`matchesTarget`) — the
 *      permanent defense-in-depth that keeps reaction counts honest — and
 *   3. that an unanchored row never matches (#25 regression pin).
 * The cms's database side (findCommentTarget, resolveWriteTarget) is tested
 * in apps/cms/src/utils/comment-target.test.ts.
 */

const DOC = "a1b2c3d4e5f6g7h8i9j0kl";
const OTHER_DOC = "z9y8x7w6v5u4t3s2r1q0po";

const target = (over: Partial<CommentTarget> = {}): CommentTarget => ({
  type: "announcement",
  documentId: DOC,
  ...over,
});

describe("isCommentTargetType", () => {
  it("accepts exactly the two draft-and-publish target types", () => {
    expect(COMMENT_TARGET_TYPES).toEqual(["announcement", "wiki-page"]);
    for (const type of COMMENT_TARGET_TYPES) expect(isCommentTargetType(type)).toBe(true);
  });

  it("refuses other values, inherited object keys included (FX27)", () => {
    for (const value of [
      "poll",
      "Announcement",
      " announcement",
      "",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      null,
      undefined,
      1,
      ["announcement"],
    ]) {
      expect(isCommentTargetType(value), String(value)).toBe(false);
    }
  });
});

describe("targetAnchor", () => {
  it("accepts a non-empty documentId and trims it", () => {
    expect(targetAnchor(` ${DOC} `)).toBe(DOC);
  });

  it("treats blank and non-string documentIds as 'no anchor'", () => {
    for (const value of ["", "  ", null, undefined, 7]) expect(targetAnchor(value)).toBeNull();
  });
});

describe("anchorFromTargetRow and targetMatchWhere", () => {
  it("takes the anchor of a looked-up row, and null for a missing one", () => {
    expect(anchorFromTargetRow({ documentId: DOC })).toBe(DOC);
    expect(anchorFromTargetRow({ documentId: " " })).toBeNull();
    expect(anchorFromTargetRow({})).toBeNull();
    expect(anchorFromTargetRow(null)).toBeNull();
    expect(anchorFromTargetRow(undefined)).toBeNull();
  });

  it("matches rows by the anchor pair and nothing else", () => {
    expect(targetMatchWhere("wiki-page", DOC)).toEqual({
      targetType: "wiki-page",
      targetDocumentId: DOC,
    });
  });
});

describe("targetFilterQuery", () => {
  it("filters by targetType plus the documentId anchor", () => {
    const query = targetFilterQuery(target());
    expect(query).toBe(
      `filters[targetType][$eq]=announcement&filters[targetDocumentId][$eq]=${DOC}`,
    );
  });

  it("returns null when the anchor is not usable — never query unfiltered", () => {
    expect(targetFilterQuery({ type: "announcement" })).toBeNull();
    expect(targetFilterQuery({ type: "wiki-page", documentId: "  " })).toBeNull();
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

  it("rejects an anchored row of a different entry", () => {
    // The re-publish trap: a foreign document must never leak into a section.
    expect(
      matchesTarget({ targetType: "announcement", targetDocumentId: OTHER_DOC }, target()),
    ).toBe(false);
  });

  it("never matches an unanchored row (#25 — legacy targetId branch removed)", () => {
    expect(matchesTarget({ targetType: "announcement", targetDocumentId: null }, target())).toBe(
      false,
    );
    expect(matchesTarget({ targetType: "announcement" }, target())).toBe(false);
  });

  it("keeps the two targetType branches apart", () => {
    const row = { targetType: "wiki-page", targetDocumentId: DOC };
    expect(matchesTarget(row, target())).toBe(false);
    expect(matchesTarget(row, target({ type: "wiki-page" }))).toBe(true);
  });
});
