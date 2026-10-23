"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";
import {
  QUIZ_CONTENT_INVALID,
  TRAINING_VERSION_CHANGED,
  type TrainingVersion,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { isSharedErrorCode, startCmsAction, type CommonCode } from "@/lib/action-result";
import { completeLesson, type TrainingActionError } from "@/lib/training-actions";

/**
 * Whether a refused completion pulls the server's state at once. Not for
 * "changed" (v0.28: an author published the lesson or course again): the
 * new version remounts the lesson, which would wipe the warning and the
 * quiz without a word, so the reader reloads with the button instead.
 */
export function refreshesAfterFailure(code: string): boolean {
  return code !== TRAINING_VERSION_CHANGED;
}

/**
 * "Mark lesson as completed" control (ack-button clone, issue #29).
 * Date labels are pre-formatted on the server; after a successful action
 * the server-side refresh() delivers the authoritative state as new
 * props. A quiz lesson's completion carries the passing answers, which
 * the cms checks (issue #70); its refusal ("quizFailed") says so and hands
 * the quiz back to the parent.
 */
export function CompleteLessonButton({
  lessonDocumentId,
  version,
  completedAtLabel,
  answers = null,
  disabled = false,
  onQuizRefused,
}: {
  /** Strapi documentId of the lesson (stable across re-publishes). */
  lessonDocumentId: string;
  /** The player's published versions (v0.28), sent back with the completion. */
  version: TrainingVersion;
  /** Pre-formatted date of the caller's own completion, or null. */
  completedAtLabel: string | null;
  /** The passing answers of the lesson's quiz, or null for a lesson without one. */
  answers?: number[] | null;
  /** Quiz lock — the quiz must be passed first (the cms checks it again). */
  disabled?: boolean;
  /** The cms refused the answers: the parent starts the quiz over. */
  onQuizRefused?: () => void;
}) {
  const t = useTranslations("training");
  const tErrors = useTranslations("actionErrors");
  const router = useRouter();
  const [justCompleted, setJustCompleted] = useState(false);
  const [error, setError] = useState<CommonCode | TrainingActionError | null>(null);
  const [isPending, startTransition] = useTransition();

  const completed = completedAtLabel !== null || justCompleted;

  const handleComplete = () => {
    if (completed || isPending || disabled) return;
    setError(null);
    startCmsAction(startTransition, {
      action: () => completeLesson(lessonDocumentId, answers, version),
      onSuccess: () => setJustCompleted(true),
      onFailure: (code) => {
        // Refused (already completed elsewhere, course unpublished, the
        // answers wrong for the current quiz, …) — surface it and pull the
        // authoritative state from the server.
        setError(code);
        if (code === "quizFailed") onQuizRefused?.();
        if (refreshesAfterFailure(code)) router.refresh();
      },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {completed ? (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {completedAtLabel ? t("completedAt", { date: completedAtLabel }) : t("completedNow")}
        </span>
      ) : (
        <Button onClick={handleComplete} disabled={isPending || disabled}>
          {isPending ? t("completing") : t("completeButton")}
        </Button>
      )}
      {error === TRAINING_VERSION_CHANGED && (
        <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
          {t("reload")}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error === "quizFailed"
            ? t("quizNotPassed")
            : error === QUIZ_CONTENT_INVALID
              ? t("quizContentInvalid")
              : error === TRAINING_VERSION_CHANGED
                ? t("versionChanged")
                : isSharedErrorCode(error)
                  ? tErrors(error)
                  : t("completeFailed")}
        </span>
      )}
    </div>
  );
}
