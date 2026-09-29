"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isSharedErrorCode, startCmsAction, type CommonCode } from "@/lib/action-result";
import { completeLesson } from "@/lib/training-actions";

/**
 * "Mark lesson as completed" control (ack-button clone, issue #29).
 * Date labels are pre-formatted on the server; after a successful action
 * the server-side refresh() delivers the authoritative state as new
 * props.
 */
export function CompleteLessonButton({
  lessonDocumentId,
  completedAtLabel,
  disabled = false,
}: {
  /** Strapi documentId of the lesson (stable across re-publishes). */
  lessonDocumentId: string;
  /** Pre-formatted date of the caller's own completion, or null. */
  completedAtLabel: string | null;
  /** quizGate lock — the quiz must be passed first (client nudge). */
  disabled?: boolean;
}) {
  const t = useTranslations("training");
  const tErrors = useTranslations("actionErrors");
  const router = useRouter();
  const [justCompleted, setJustCompleted] = useState(false);
  const [error, setError] = useState<CommonCode | null>(null);
  const [isPending, startTransition] = useTransition();

  const completed = completedAtLabel !== null || justCompleted;

  const handleComplete = () => {
    if (completed || isPending || disabled) return;
    setError(null);
    startCmsAction(startTransition, {
      action: () => completeLesson(lessonDocumentId),
      onSuccess: () => setJustCompleted(true),
      onFailure: (code) => {
        // Refused (already completed elsewhere, course unpublished, …) —
        // surface it and pull the authoritative state from the server.
        setError(code);
        router.refresh();
      },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {completed ? (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {completedAtLabel ? t("completedAt", { date: completedAtLabel }) : t("completedNow")}
        </span>
      ) : (
        <Button onClick={handleComplete} disabled={isPending || disabled}>
          {isPending ? t("completing") : t("completeButton")}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {isSharedErrorCode(error) ? tErrors(error) : t("completeFailed")}
        </span>
      )}
    </div>
  );
}
