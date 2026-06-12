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

/** Collapse raw reaction rows into per-emoji counts + "did I react". */
export function summarize(reactions: Reaction[], userId?: number): ReactionSummary[] {
  const map = new Map<EmojiType, { count: number; reacted: boolean }>();
  for (const emoji of ALL_EMOJIS) {
    map.set(emoji, { count: 0, reacted: false });
  }
  for (const r of reactions) {
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
