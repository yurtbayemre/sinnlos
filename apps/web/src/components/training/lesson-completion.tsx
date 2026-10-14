"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { CompleteLessonButton } from "@/components/training/complete-lesson-button";
import { QuizBlock } from "@/components/training/quiz-block";
import { quizGatesCompletion, type CompletionMode, type QuizQuestion } from "@/lib/training-shared";

/**
 * Client wrapper tying the quiz to the completion button (issue #29; issue
 * #70): on every course the button of a lesson with questions stays locked
 * until all answers are correct, and the completion sends them, so the cms
 * can check them too. The course's completionMode picks the feedback only:
 * per answer ("confirm") or one batch check ("quizGate"). Already-completed
 * lessons show the quiz in instant mode for review and are never re-locked.
 * Lessons WITHOUT a quiz pass trivially (fail-open for content gaps — a
 * gate must never dead-lock a lesson, see evaluateQuiz). When the cms
 * refuses the answers anyway (the quiz changed since the page loaded), the
 * quiz starts over.
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
  nextHref: Route | null;
}) {
  const t = useTranslations("training");
  const gated = quizGatesCompletion(quiz, completedAtLabel !== null);
  // The answers that passed the quiz, sent with the completion; null until then.
  const [answers, setAnswers] = useState<number[] | null>(null);
  // Bumped when the cms refuses the answers: a new QuizBlock, empty.
  const [attempt, setAttempt] = useState(0);
  const locked = gated && answers === null;

  return (
    <>
      <QuizBlock
        key={attempt}
        quiz={quiz}
        mode={gated && completionMode === "quizGate" ? "check" : "instant"}
        onPassedChange={gated ? setAnswers : undefined}
      />
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <div className="space-y-1.5">
          <CompleteLessonButton
            lessonDocumentId={lessonDocumentId}
            completedAtLabel={completedAtLabel}
            answers={gated ? answers : null}
            disabled={locked}
            onQuizRefused={() => {
              setAnswers(null);
              setAttempt((n) => n + 1);
            }}
          />
          {locked && <p className="text-xs text-muted-foreground">{t("completeLocked")}</p>}
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
