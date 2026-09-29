"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { isSharedErrorCode, startCmsAction, type CommonCode } from "@/lib/action-result";
import { toggleReaction } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import { applyReactionIntent, reactionIntent } from "@/lib/optimistic";
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
  /** Called after a successful change so the owner can refetch its data. */
  onChanged?: () => void | Promise<void>;
}) {
  const t = useTranslations("comments");
  const tErrors = useTranslations("actionErrors");
  const [, startTransition] = useTransition();
  const [failed, setFailed] = useState<CommonCode | null>(null);
  // Optimistic update (issue #34, FX28): the bar shows the new state at
  // once, the awaited refetch in the same transition delivers the
  // authoritative summary as the new base state, and a rejected action
  // falls back to the unchanged base. The update carries the desired end
  // state, so re-running it on a refetched base cannot flip it back
  // (lib/optimistic.ts).
  const [optimisticReactions, applyIntent] = useOptimistic(reactions, applyReactionIntent);
  // One request per emoji at a time: a double click must not send the
  // opposite state before the first request settled.
  const pendingRef = useRef(new Set<EmojiType>());
  // Toggling requires the documentId anchor. Every Strapi 5 row has one, so
  // this only guards against an unanchored write (issue #11).
  const canReact = Boolean(target.documentId);

  const handleToggle = (emoji: EmojiType) => {
    if (!canReact || pendingRef.current.has(emoji)) return;
    const intent = reactionIntent(optimisticReactions, emoji);
    pendingRef.current.add(emoji);
    setFailed(null);
    // A refused or failed write stays here as an inline error (AC01; the
    // helper rethrows an expired session's redirect), and the optimistic
    // state falls back to the unchanged base.
    startCmsAction(startTransition, {
      optimistic: () => applyIntent(intent),
      action: () => toggleReaction(target, intent.emoji, intent.reacted),
      onSuccess: () => onChanged?.(),
      onFailure: setFailed,
      onSettled: () => pendingRef.current.delete(emoji),
    });
  };

  const reactionMap = new Map(optimisticReactions.map((r) => [r.emoji, r]));

  return (
    <div className="space-y-1">
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
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {isSharedErrorCode(failed) ? tErrors(failed) : t("reactionFailed")}
        </p>
      )}
    </div>
  );
}
