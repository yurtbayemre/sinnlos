import { describe, expect, it } from "vitest";
import type { Reaction } from "@/lib/types";
import { ALL_EMOJIS, summarize } from "./reaction-summary";

/** Minimal Reaction factory — only the fields `summarize` reads matter. */
function reaction(emoji: Reaction["emoji"], authorId?: number): Reaction {
  return {
    id: Math.floor(Math.random() * 1e9),
    emoji,
    targetType: "announcement",
    targetId: 1,
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
