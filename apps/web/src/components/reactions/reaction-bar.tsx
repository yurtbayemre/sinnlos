"use client";

import { useTransition } from "react";
import { cn } from "@/lib/utils";
import { toggleReaction } from "@/lib/comment-actions";
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
  targetType,
  targetId,
  reactions,
}: {
  targetType: "announcement" | "wiki-page";
  targetId: number;
  reactions: ReactionSummary[];
}) {
  const [isPending, startTransition] = useTransition();

  const handleToggle = (emoji: EmojiType) => {
    startTransition(async () => {
      await toggleReaction(targetType, targetId, emoji);
    });
  };

  const reactionMap = new Map(reactions.map((r) => [r.emoji, r]));

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", isPending && "opacity-60")}>
      {ALL_EMOJIS.map((emoji) => {
        const r = reactionMap.get(emoji);
        const count = r?.count ?? 0;
        const reacted = r?.reacted ?? false;
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => handleToggle(emoji)}
            disabled={isPending}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
              reacted
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-transparent hover:border-border hover:bg-muted",
              count === 0 && !reacted && "opacity-40 hover:opacity-100",
            )}
          >
            <span>{EMOJI_MAP[emoji]}</span>
            {count > 0 && <span className="font-medium">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
