import { matchesTarget, type CommentTarget } from "@/lib/comment-target";
import type { Comment, EmojiType, Reaction, ReactionSummary } from "@/lib/types";

export type CommentSectionData = {
  comments: Comment[];
  reactions: ReactionSummary[];
};

export const ALL_EMOJIS: EmojiType[] = ["thumbsup", "heart", "celebrate", "lightbulb", "laugh"];

/**
 * Collapse raw reaction rows into per-emoji counts + "did I react".
 *
 * Pass `target` to also verify that every row really belongs to that entry:
 * rows are anchored by `targetDocumentId` (issue #11), and the counts
 * re-check the anchor rather than trusting the query — permanent
 * defense-in-depth against a mis-built fetch filter. Without `target` every
 * row is counted (the pre-#11 behaviour).
 */
export function summarize(
  reactions: Reaction[],
  userId?: number,
  target?: CommentTarget,
): ReactionSummary[] {
  const map = new Map<EmojiType, { count: number; reacted: boolean }>();
  for (const emoji of ALL_EMOJIS) {
    map.set(emoji, { count: 0, reacted: false });
  }
  for (const r of reactions) {
    if (target && !matchesTarget(r, target)) continue;
    const entry = map.get(r.emoji);
    if (entry) {
      entry.count++;
      if (userId != null && r.author?.id === userId) entry.reacted = true;
    }
  }
  return ALL_EMOJIS.map((emoji) => ({
    emoji,
    ...map.get(emoji)!,
  }));
}

/**
 * Marks the emojis of the caller's own reactions that `summary` missed:
 * getCommentSection summarises only the newest rows of a target, and an
 * older own reaction must still show as pressed, or the next click asks for
 * `reacted: true`, which the CMS answers with a no-op (FX28), and the user
 * can never remove it. `ownRows` are the caller's rows of this target; each
 * is re-checked for the target and the author (defense-in-depth, as in
 * summarize). A row the summary missed was not counted either, so the
 * count grows by one.
 */
export function withOwnReactions(
  summary: ReactionSummary[],
  ownRows: Reaction[],
  userId: number,
  target: CommentTarget,
): ReactionSummary[] {
  const own = new Set<EmojiType>();
  for (const r of ownRows) {
    if (matchesTarget(r, target) && r.author?.id === userId) own.add(r.emoji);
  }
  return summary.map((entry) =>
    entry.reacted || !own.has(entry.emoji)
      ? entry
      : { ...entry, reacted: true, count: entry.count + 1 },
  );
}
