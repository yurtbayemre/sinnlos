"use client";

import { useOptimistic, useTransition } from "react";
import { cn } from "@/lib/utils";
import { toggleReaction } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import type { EmojiType, ReactionSummary } from "@/lib/types";

const EMOJI_MAP: Record<EmojiType, string> = {
  thumbsup: "\u{1F44D}",
  heart: "❤️",
  celebrate: "\u{1F389}",
  lightbulb: "\u{1F4A1}",
  laugh: "\u{1F604}",
};

const ALL_EMOJIS: EmojiType[] = ["thumbsup", "heart", "celebrate", "lightbulb", "laugh"];

export function ReactionBar({
  target,
  reactions,
  onChanged,
}: {
  /** Target of the bar, anchored by documentId (issue #11). */
  target: CommentTarget;
  reactions: ReactionSummary[];
  /** Called after a successful toggle so the owner can refetch its data. */
  onChanged?: () => void | Promise<void>;
}) {
  const [, startTransition] = useTransition();
  // Optimistic toggle (issue #34): the bar flips instantly, the awaited
  // refetch in the same transition delivers the authoritative summary as
  // the new base state, and a rejected action rolls back automatically —
  // no dead UI during the two roundtrips.
  const [optimisticReactions, applyToggle] = useOptimistic(
    reactions,
    (current: ReactionSummary[], emoji: EmojiType) => {
      const existing = current.find((r) => r.emoji === emoji);
      if (!existing) return [...current, { emoji, count: 1, reacted: true }];
      return current.map((r) =>
        r.emoji === emoji ? { ...r, count: r.count + (r.reacted ? -1 : 1), reacted: !r.reacted } : r,
      );
    },
  );
  // Toggling requires the documentId anchor. Every Strapi 5 row has one, so
  // this only guards against an unanchored write (issue #11).
  const canReact = Boolean(target.documentId);

  const handleToggle = (emoji: EmojiType) => {
    if (!canReact) return;
    startTransition(async () => {
      applyToggle(emoji);
      await toggleReaction(target, emoji);
      await onChanged?.();
    });
  };

  const reactionMap = new Map(optimisticReactions.map((r) => [r.emoji, r]));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ALL_EMOJIS.map((emoji) => {
        const r = reactionMap.get(emoji);
        const count = r?.count ?? 0;
        const reacted = r?.reacted ?? false;
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => handleToggle(emoji)}
            disabled={!canReact}
            aria-pressed={reacted}
            aria-label={`${EMOJI_MAP[emoji]} ${count}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              reacted
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-transparent hover:border-border hover:bg-muted",
              count === 0 && !reacted && "opacity-40 hover:opacity-100",
            )}
          >
            <span aria-hidden="true">{EMOJI_MAP[emoji]}</span>
            {count > 0 && <span className="font-medium">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
