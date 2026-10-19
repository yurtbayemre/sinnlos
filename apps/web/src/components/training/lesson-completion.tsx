"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { CompleteLessonButton } from "@/components/training/complete-lesson-button";
import { QuizBlock } from "@/components/training/quiz-block";
import {
  quizGatesCompletion,
  type CompletionMode,
  type LearnerQuizQuestion,
} from "@/lib/training-shared";

/** Quiz feedback unlocks completion; the CMS independently grades the submitted answers. */
export function LessonCompletion({
  quiz,
  completionMode,
  lessonDocumentId,
  completedAtLabel,
  nextHref,
}: {
  quiz: LearnerQuizQuestion[];
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
        lessonDocumentId={lessonDocumentId}
        completionMode={completionMode}
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
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary outline-hidden transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t("nextLesson")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </footer>
    </>
  );
}
