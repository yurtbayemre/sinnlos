"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { MessageCircle, Send, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import { addComment, deleteComment } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import { relativeTime } from "@/lib/relative-time";
import type { Comment } from "@/lib/types";

export function CommentThread({
  target,
  comments,
  currentUserId,
  onChanged,
}: {
  /** Target of the thread, anchored by documentId (issue #11). */
  target: CommentTarget;
  comments: Comment[];
  currentUserId?: number;
  /** Called after a successful mutation so the owner can refetch its data. */
  onChanged?: () => void | Promise<void>;
}) {
  const tComments = useTranslations("comments");
  const tCommon = useTranslations("common");
  const tRel = useTranslations("relativeTime");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Writing requires the documentId anchor. Every Strapi 5 row has one, so
  // this only guards against an unanchored write (issue #11).
  const canWrite = Boolean(target.documentId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text || !canWrite) return;
    setError(null);
    startTransition(async () => {
      try {
        await addComment(target, text);
      } catch {
        // Keep the draft in the input so the user can retry.
        setError(tComments("sendFailed"));
        return;
      }
      setBody("");
      await onChanged?.();
    });
  };

  const handleDelete = (id: number) => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteComment(id);
      } catch {
        setError(tComments("deleteFailed"));
        return;
      }
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
              c.author?.displayName ?? c.author?.username ?? c.author?.email ?? tCommon("unknown");
            const isOwner = currentUserId != null && c.author?.id === currentUserId;
            return (
              <div key={c.id} className="flex gap-3">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{name}</span>
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(c.createdAt, tRel)}
                    </span>
                    {isOwner && (
                      <button
                        type="button"
                        onClick={() => handleDelete(c.id)}
                        disabled={isPending}
                        className="ml-auto rounded-md text-muted-foreground outline-none transition-colors hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          placeholder={tComments("writeComment")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isPending || !canWrite}
          className="h-10 flex-1 rounded-xl border bg-muted/40 px-4 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isPending || !canWrite || !body.trim()}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
          aria-label={tComments("sendComment")}
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
