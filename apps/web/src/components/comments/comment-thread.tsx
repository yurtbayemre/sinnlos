"use client";

import { useState, useTransition } from "react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { MessageCircle, Send, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import { isSharedErrorCode, startCmsAction, type CommonCode } from "@/lib/action-result";
import { addComment, deleteComment } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import { DEFAULT_APP_TIME_ZONE } from "@/lib/plain-date";
import { relativeTime } from "@/lib/relative-time";
import type { Comment } from "@/lib/types";

export function CommentThread({
  target,
  comments,
  currentUserId,
  canComment,
  canDeleteOwn,
  onChanged,
}: {
  /** Target of the thread, anchored by documentId (issue #11). */
  target: CommentTarget;
  comments: Comment[];
  currentUserId?: number;
  /** The viewer's role may comment (SH02): otherwise no form. */
  canComment: boolean;
  /** The viewer's role may delete its own comments (SH02): otherwise no delete button. */
  canDeleteOwn: boolean;
  /** Called after a successful mutation so the owner can refetch its data. */
  onChanged?: () => void | Promise<void>;
}) {
  const tComments = useTranslations("comments");
  const tCommon = useTranslations("common");
  const tRel = useTranslations("relativeTime");
  const tErrors = useTranslations("actionErrors");
  // The app locale and APP_TIME_ZONE from the provider (i18n/request.ts),
  // so the server render and the hydrated client show the same label. The
  // root layout always sets the zone; the fallback is APP_TIME_ZONE's default.
  const locale = useLocale();
  const timeZone = useTimeZone() ?? DEFAULT_APP_TIME_ZONE;
  const [body, setBody] = useState("");
  // The failed write and its code (AC01); translated when rendered.
  const [error, setError] = useState<{ write: "send" | "delete"; code: CommonCode } | null>(null);
  const [isPending, startTransition] = useTransition();
  // Writing requires the documentId anchor. Every Strapi 5 row has one, so
  // this only guards against an unanchored write (issue #11).
  const canWrite = Boolean(target.documentId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text || !canWrite) return;
    setError(null);
    startCmsAction(startTransition, {
      action: () => addComment(target, text),
      onSuccess: async () => {
        setBody("");
        await onChanged?.();
      },
      // The draft stays in the input so the user can retry.
      onFailure: (code) => setError({ write: "send", code }),
    });
  };

  const handleDelete = (id: number) => {
    setError(null);
    startCmsAction(startTransition, {
      action: () => deleteComment(id),
      onSuccess: () => onChanged?.(),
      onFailure: (code) => setError({ write: "delete", code }),
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
            const deletable = isOwner && canDeleteOwn;
            return (
              <div key={c.id} className="flex gap-3">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{name}</span>
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(c.createdAt, tRel, { locale, timeZone })}
                    </span>
                    {deletable && (
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
          {isSharedErrorCode(error.code)
            ? tErrors(error.code)
            : tComments(error.write === "send" ? "sendFailed" : "deleteFailed")}
        </p>
      )}

      {canComment && (
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
      )}
    </div>
  );
}
