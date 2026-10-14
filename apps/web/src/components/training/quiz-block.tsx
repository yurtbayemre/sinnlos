"use client";

import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { evaluateQuiz, passingAnswers, type QuizQuestion } from "@/lib/training-shared";

/**
 * Lesson quiz (issue #29). Two modes, chosen by the course's
 * completionMode:
 *
 *  - "instant" (confirm courses, and every completed lesson for review):
 *    pick an option → immediate right/wrong feedback, retry allowed.
 *  - "check" (quizGate courses): answers are collected WITHOUT feedback
 *    and evaluated in one batch via the "check answers" button; wrong
 *    ones get marked, can be changed and re-checked (unlimited retries).
 *
 * With `onPassedChange` the quiz gates the lesson's completion (issue #70:
 * every open lesson with questions, in either mode): it hands the parent
 * the passing answers once all are correct (instant: with the last right
 * pick; check: with the passed check), which unlock the completion button
 * and go with the completion; in instant mode null again after a wrong
 * pick. The cms checks the answers itself (lesson-progress create): this
 * gate is the feedback, that one holds. Answers are never stored, and
 * correctIndex ships to the client (a real exam mode is a documented v2).
 */
export function QuizBlock({
  quiz,
  mode,
  onPassedChange,
}: {
  quiz: QuizQuestion[];
  mode: "instant" | "check";
  onPassedChange?: (answers: number[] | null) => void;
}) {
  const t = useTranslations("training");
  const [answers, setAnswers] = useState<Record<number, number | undefined>>({});
  const [checked, setChecked] = useState(false);
  const [passed, setPassed] = useState(false);

  if (quiz.length === 0) return null;

  const evaluation = evaluateQuiz(quiz, answers);
  const gating = onPassedChange !== undefined;

  const pick = (qi: number, oi: number) => {
    if (passed) return;
    const next = { ...answers, [qi]: oi };
    setAnswers(next);
    // A changed answer invalidates the last batch verdict.
    if (mode === "check") setChecked(false);
    // Instant feedback: the gate opens with the last right pick, closes with a wrong one.
    else onPassedChange?.(passingAnswers(quiz, next));
  };

  const check = () => {
    setChecked(true);
    const passing = passingAnswers(quiz, answers);
    if (passing) {
      setPassed(true);
      onPassedChange?.(passing);
    }
  };

  const showFeedbackFor = (qi: number): boolean =>
    mode === "instant" ? answers[qi] !== undefined : checked || passed;

  return (
    <section className="space-y-4 rounded-xl border p-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        {mode === "check" || gating ? t("quizGateTitle") : t("quizTitle")}
      </h2>
      {mode === "check" && !passed && (
        <p className="text-xs text-muted-foreground">{t("quizGateHint")}</p>
      )}
      {mode === "instant" && gating && !evaluation.passed && (
        <p className="text-xs text-muted-foreground">{t("quizInstantHint")}</p>
      )}
      {quiz.map((q, qi) => {
        const picked = answers[qi];
        const feedback = showFeedbackFor(qi);
        return (
          <div key={qi} className="space-y-2">
            <div className="text-sm font-medium">{q.question}</div>
            {/* Honest toggle-button semantics (issue #35): role="radio"
                would demand APG roving tabindex + arrow-key movement.
                Plain buttons with aria-pressed announce exactly the
                interaction model that exists — every option a tab stop,
                Enter/Space picks. */}
            <div className="grid gap-2" role="group" aria-label={q.question}>
              {q.options.map((option, oi) => {
                const isPicked = picked === oi;
                const isCorrect = oi === q.correctIndex;
                const state = feedback && isPicked ? (isCorrect ? "right" : "wrong") : "neutral";
                return (
                  <button
                    key={oi}
                    type="button"
                    aria-pressed={isPicked}
                    disabled={passed}
                    onClick={() => pick(qi, oi)}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default ${
                      state === "right"
                        ? "border-emerald-500/60 bg-emerald-500/10"
                        : state === "wrong"
                          ? "border-red-500/60 bg-red-500/10"
                          : isPicked
                            ? "border-primary/60 bg-primary/10"
                            : "hover:bg-muted/50"
                    }`}
                  >
                    <span>{option}</span>
                    {state === "right" && (
                      <CheckCircle2
                        className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                        aria-hidden="true"
                      />
                    )}
                    {state === "wrong" && (
                      <XCircle
                        className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
            {mode === "instant" && picked !== undefined && (
              <p
                className={`text-xs ${
                  picked === q.correctIndex
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {picked === q.correctIndex ? t("quizCorrect") : t("quizWrong")}
              </p>
            )}
          </div>
        );
      })}
      {mode === "instant" && gating && evaluation.passed && (
        <p className="inline-flex items-center gap-1.5 pt-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {t("quizAllCorrect")}
        </p>
      )}
      {mode === "check" && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {passed ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {t("quizAllCorrect")}
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={check}
                disabled={!evaluation.answeredAll}
                className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
              >
                {t("quizCheckButton")}
              </button>
              {!evaluation.answeredAll && (
                <span className="text-xs text-muted-foreground">{t("quizAnswerAll")}</span>
              )}
              {checked && evaluation.wrong.length > 0 && (
                <span className="text-sm text-red-600 dark:text-red-400">
                  {t("quizSomeWrong", { count: evaluation.wrong.length })}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
