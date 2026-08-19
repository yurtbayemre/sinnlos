import { matchesTarget, type CommentTarget } from "@/lib/comment-target";
import type { Comment, EmojiType, Reaction, ReactionSummary } from "@/lib/types";

export type CommentSectionData = {
  comments: Comment[];
  reactions: ReactionSummary[];
};

export const ALL_EMOJIS: EmojiType[] = [
  "thumbsup",
  "heart",
  "celebrate",
  "lightbulb",
  "laugh",
];

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
