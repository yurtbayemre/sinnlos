"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { CompleteLessonButton } from "@/components/training/complete-lesson-button";
import { QuizBlock } from "@/components/training/quiz-block";
import type { CompletionMode, QuizQuestion } from "@/lib/training-shared";

/**
 * Client wrapper tying the quiz to the completion button (issue #29,
 * quizGate flow): on quizGate courses the button stays locked until the
 * batch check reports all answers correct. Already-completed lessons
 * show the quiz in instant mode for review and are never re-locked.
 * quizGate lessons WITHOUT a quiz pass trivially (fail-open for content
 * gaps — a gate must never dead-lock a lesson, see evaluateQuiz).
 */
export function LessonCompletion({
  quiz,
  completionMode,
  lessonDocumentId,
  completedAtLabel,
  nextHref,
}: {
  quiz: QuizQuestion[];
  completionMode: CompletionMode;
  lessonDocumentId: string;
  completedAtLabel: string | null;
  nextHref: string | null;
}) {
  const t = useTranslations("training");
  const alreadyCompleted = completedAtLabel !== null;
  const gated = completionMode === "quizGate" && !alreadyCompleted && quiz.length > 0;
  const [passed, setPassed] = useState(!gated);

  return (
    <>
      <QuizBlock
        quiz={quiz}
        mode={gated ? "check" : "instant"}
        onPassedChange={gated ? setPassed : undefined}
      />
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <div className="space-y-1.5">
          <CompleteLessonButton
            lessonDocumentId={lessonDocumentId}
            completedAtLabel={completedAtLabel}
            disabled={!passed}
          />
          {!passed && <p className="text-xs text-muted-foreground">{t("completeLocked")}</p>}
        </div>
        {nextHref && (
          <Link
            href={nextHref}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t("nextLesson")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </footer>
    </>
  );
}
