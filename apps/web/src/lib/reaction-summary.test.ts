import { describe, expect, it } from "vitest";
import type { CommentTarget } from "@/lib/comment-target";
import type { Reaction } from "@/lib/types";
import { ALL_EMOJIS, summarize } from "./reaction-summary";

/** The announcement every reaction below belongs to (documentId-anchored). */
const DOC = "a1b2c3d4e5f6g7h8i9j0kl";
const OTHER_DOC = "z9y8x7w6v5u4t3s2r1q0po";
const TARGET: CommentTarget = { type: "announcement", documentId: DOC, id: 1 };

/** Minimal Reaction factory — only the fields `summarize` reads matter. */
function reaction(emoji: Reaction["emoji"], authorId?: number): Reaction {
  return {
    id: Math.floor(Math.random() * 1e9),
    emoji,
    targetType: "announcement",
    targetDocumentId: DOC,
    author: authorId != null ? { id: authorId, displayName: "u", email: "u@x" } : null,
  } as Reaction;
}

describe("summarize", () => {
  it("returns one entry per known emoji, all zeroed, for empty input", () => {
    const result = summarize([]);
    expect(result).toEqual(
      ALL_EMOJIS.map((emoji) => ({ emoji, count: 0, reacted: false })),
    );
  });

  it("preserves the canonical ALL_EMOJIS order regardless of input order", () => {
    const result = summarize([reaction("laugh"), reaction("thumbsup")]);
    expect(result.map((r) => r.emoji)).toEqual(ALL_EMOJIS);
  });

  it("counts reactions per emoji", () => {
    const result = summarize([
      reaction("thumbsup"),
      reaction("thumbsup"),
      reaction("heart"),
    ]);
    const byEmoji = Object.fromEntries(result.map((r) => [r.emoji, r.count]));
    expect(byEmoji.thumbsup).toBe(2);
    expect(byEmoji.heart).toBe(1);
    expect(byEmoji.celebrate).toBe(0);
  });

  it("ignores unknown emoji values without throwing or leaking entries", () => {
    const bad = { ...reaction("thumbsup"), emoji: "rocket" } as unknown as Reaction;
    const result = summarize([bad, reaction("heart")]);
    // No extra entry, only the heart counted.
    expect(result).toHaveLength(ALL_EMOJIS.length);
    const heart = result.find((r) => r.emoji === "heart");
    expect(heart?.count).toBe(1);
    expect(result.some((r) => (r.emoji as string) === "rocket")).toBe(false);
  });

  it("marks reacted=true only for the emoji the given user reacted with", () => {
    const me = 42;
    const result = summarize(
      [
        reaction("thumbsup", me),
        reaction("heart", 7), // someone else
        reaction("celebrate"), // anonymous author
      ],
      me,
    );
    const byEmoji = Object.fromEntries(result.map((r) => [r.emoji, r.reacted]));
    expect(byEmoji.thumbsup).toBe(true);
    expect(byEmoji.heart).toBe(false);
    expect(byEmoji.celebrate).toBe(false);
  });

  it("never marks reacted when no userId is supplied", () => {
    const result = summarize([reaction("thumbsup", 42), reaction("heart", 7)]);
    expect(result.every((r) => r.reacted === false)).toBe(true);
  });

  it("counts every reaction for an emoji but only flags reacted once", () => {
    const me = 5;
    const result = summarize(
      [reaction("heart", me), reaction("heart", 9), reaction("heart", me)],
      me,
    );
    const heart = result.find((r) => r.emoji === "heart")!;
    expect(heart.count).toBe(3);
    expect(heart.reacted).toBe(true);
  });

  it("does not flag reacted for a different userId even when present", () => {
    const result = summarize([reaction("heart", 7)], 42);
    const heart = result.find((r) => r.emoji === "heart")!;
    expect(heart.count).toBe(1);
    expect(heart.reacted).toBe(false);
  });
});

/**
 * Target-scoped aggregation (issue #11): rows are anchored by
 * `targetDocumentId`, and the fetch filter still carries a temporary branch
 * for rows the CMS backfill has not anchored yet — so the counts re-check the
 * anchor instead of trusting the query.
 */
describe("summarize with a target", () => {
  const me = 5;

  it("counts documentId-anchored rows of that target", () => {
    const result = summarize([reaction("heart", me), reaction("heart", 9)], me, TARGET);
    const heart = result.find((r) => r.emoji === "heart")!;
    expect(heart.count).toBe(2);
    expect(heart.reacted).toBe(true);
  });

  it("drops rows of another entry that reuse the target's old row id", () => {
    // Post-re-publish trap: row id 1 now belongs to this announcement, but
    // this reaction is anchored to a different document.
    const foreign = {
      ...reaction("heart", me),
      targetDocumentId: OTHER_DOC,
      targetId: 1,
    } as Reaction;
    const result = summarize([foreign, reaction("thumbsup", 9)], me, TARGET);
    const byEmoji = Object.fromEntries(result.map((r) => [r.emoji, r.count]));
    expect(byEmoji.heart).toBe(0);
    expect(byEmoji.thumbsup).toBe(1);
    expect(result.find((r) => r.emoji === "heart")!.reacted).toBe(false);
  });

  it("still counts unanchored legacy rows of the target (temporary bridge)", () => {
    const legacy = {
      ...reaction("celebrate", me),
      targetDocumentId: null,
      targetId: 1,
    } as Reaction;
    const result = summarize([legacy], me, TARGET);
    const celebrate = result.find((r) => r.emoji === "celebrate")!;
    expect(celebrate.count).toBe(1);
    expect(celebrate.reacted).toBe(true);
  });

  it("drops rows of the other targetType with the same documentId", () => {
    const wiki = { ...reaction("laugh", 9), targetType: "wiki-page" } as Reaction;
    const result = summarize([wiki], me, TARGET);
    expect(result.find((r) => r.emoji === "laugh")!.count).toBe(0);
  });

  it("counts everything when no target is passed (pre-#11 behaviour)", () => {
    const foreign = { ...reaction("heart", 9), targetDocumentId: OTHER_DOC } as Reaction;
    const result = summarize([foreign]);
    expect(result.find((r) => r.emoji === "heart")!.count).toBe(1);
  });
});
