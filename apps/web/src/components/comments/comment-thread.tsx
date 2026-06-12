"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { MessageCircle, Send, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import { addComment, deleteComment } from "@/lib/comment-actions";
import type { Comment } from "@/lib/types";

function relative(dateStr: string | undefined, t: ReturnType<typeof useTranslations<"comments">>) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const day = 86400000;
  if (diff < day) return t("today");
  if (diff < 2 * day) return t("yesterday");
  if (diff < 7 * day) return t("daysAgo", { days: Math.floor(diff / day) });
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function CommentThread({
  targetType,
  targetId,
  comments,
  currentUserId,
  onChanged,
}: {
  targetType: "announcement" | "wiki-page";
  targetId: number;
  comments: Comment[];
  currentUserId?: number;
  /** Called after a successful mutation so the owner can refetch its data. */
  onChanged?: () => void | Promise<void>;
}) {
  const tComments = useTranslations("comments");
  const tCommon = useTranslations("common");
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBody("");
    startTransition(async () => {
      await addComment(targetType, targetId, text);
      await onChanged?.();
    });
  };

  const handleDelete = (id: number) => {
    startTransition(async () => {
      await deleteComment(id);
      await onChanged?.();
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <MessageCircle className="h-4 w-4" />
        {tCommon("comment", { count: comments.length })}
      </div>

      {comments.length > 0 && (
        <div className="space-y-3">
          {comments.map((c) => {
            const name =
              c.author?.displayName ??
              c.author?.username ??
              c.author?.email ??
              "Unknown";
            const isOwner = currentUserId != null && c.author?.id === currentUserId;
            return (
              <div key={c.id} className="flex gap-3">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-xs">
                    {initials(name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{name}</span>
                    <span className="text-xs text-muted-foreground">
                      {relative(c.createdAt, tComments)}
                    </span>
                    {isOwner && (
                      <button
                        type="button"
                        onClick={() => handleDelete(c.id)}
                        disabled={isPending}
                        className="ml-auto text-muted-foreground transition hover:text-destructive"
                        aria-label={tComments("deleteComment")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                    {c.body}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          placeholder={tComments("writeComment")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isPending}
          className="h-10 flex-1 rounded-xl border bg-muted/40 px-4 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isPending || !body.trim()}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          aria-label={tComments("sendComment")}
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
