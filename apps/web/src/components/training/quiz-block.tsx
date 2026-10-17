"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { QUIZ_CONTENT_INVALID, type QuizCheckResponse } from "@sinnlos/domain";
import { isSharedErrorCode, startCmsAction, type CommonCode } from "@/lib/action-result";
import { checkLesson, type TrainingActionError } from "@/lib/training-actions";
import type { CompletionMode, LearnerQuizQuestion } from "@/lib/training-shared";

/** One answerless player: only the CMS supplies verdicts, including during completed review. */
export function QuizBlock({
  quiz,
  lessonDocumentId,
  completionMode,
  onPassedChange,
}: {
  quiz: LearnerQuizQuestion[];
  lessonDocumentId: string;
  completionMode: CompletionMode;
  onPassedChange?: (answers: number[] | null) => void;
}) {
  const t = useTranslations("training");
  const tErrors = useTranslations("actionErrors");
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [mode, setMode] = useState(completionMode);
  const [feedback, setFeedback] = useState<QuizCheckResponse["data"] | null>(null);
  const [error, setError] = useState<CommonCode | TrainingActionError | null>(null);
  const [isPending, startTransition] = useTransition();
  const revision = useRef(0);
  useEffect(
    () => () => {
      // A reset quiz must never be unlocked by a response to its unmounted predecessor.
      revision.current++;
    },
    [],
  );

  if (quiz.length === 0) return null;

  const answeredAll = quiz.every((_, qi) => answers[qi] !== undefined);
  const passed = answeredAll && feedback?.passed === true;
  const verdicts = mode === "exam" ? [] : (feedback?.verdicts ?? []);
  const wrong = verdicts.filter((verdict) => !verdict.correct).length;

  const check = (selection: Record<number, number>, current: number) => {
    startCmsAction(startTransition, {
      action: () =>
        checkLesson(
          lessonDocumentId,
          Object.entries(selection).map(([questionIndex, optionIndex]) => ({
            questionIndex: Number(questionIndex),
            optionIndex,
          })),
        ),
      onSuccess: (result) => {
        // Changed answers supersede every earlier request, even if responses arrive out of order.
        if (revision.current !== current) return;
        if (!result) {
          setError("failed");
          return;
        }
        setMode(result.completionMode);
        setFeedback(result);
        onPassedChange?.(
          result.passed && quiz.every((_, qi) => selection[qi] !== undefined)
            ? quiz.map((_, qi) => selection[qi]!)
            : null,
        );
      },
      onFailure: (code) => {
        if (revision.current !== current) return;
        setError(code);
        // A partial confirm submission may have reached a course switched to a batch mode.
        if (code === "quizFailed" || code === "notFound") router.refresh();
      },
    });
  };

  const pick = (qi: number, oi: number) => {
    const next = { ...answers, [qi]: oi };
    const current = ++revision.current;
    setAnswers(next);
    setFeedback(null);
    setError(null);
    onPassedChange?.(null);
    if (mode === "confirm") check(next, current);
  };

  const checkAll = () => {
    if (!answeredAll || isPending) return;
    setFeedback(null);
    setError(null);
    onPassedChange?.(null);
    check(answers, ++revision.current);
  };

  return (
    <section className="space-y-4 rounded-xl border p-4" aria-busy={isPending}>
      <h2 className="text-sm font-medium text-muted-foreground">
        {onPassedChange ? t("quizGateTitle") : t("quizTitle")}
      </h2>
      <p className="text-xs text-muted-foreground">
        {mode === "exam"
          ? t("quizExamHint")
          : mode === "quizGate"
            ? t("quizGateHint")
            : t("quizInstantHint")}
      </p>
      {quiz.map((q, qi) => {
        const picked = answers[qi];
        const verdict = verdicts.find((entry) => entry.questionIndex === qi);
        return (
          <div key={qi} className="space-y-2">
            <div className="text-sm font-medium">{q.question}</div>
            <div className="grid gap-2" role="group" aria-label={q.question}>
              {q.options.map((option, oi) => {
                const isPicked = picked === oi;
                const state =
                  isPicked && verdict ? (verdict.correct ? "right" : "wrong") : "neutral";
                return (
                  <button
                    key={oi}
                    type="button"
                    aria-pressed={isPicked}
                    onClick={() => pick(qi, oi)}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
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
            {verdict && (
              <p
                role="status"
                className={`text-xs ${verdict.correct ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
              >
                {verdict.correct ? t("quizCorrect") : t("quizWrong")}
              </p>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        {mode !== "confirm" && !passed && (
          <>
            <button
              type="button"
              onClick={checkAll}
              disabled={!answeredAll || isPending}
              className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
            >
              {isPending ? t("quizChecking") : t("quizCheckButton")}
            </button>
            {!answeredAll && (
              <span className="text-xs text-muted-foreground">{t("quizAnswerAll")}</span>
            )}
          </>
        )}
        <span
          role="status"
          className={
            passed
              ? "text-sm text-emerald-700 dark:text-emerald-400"
              : "text-sm text-muted-foreground"
          }
        >
          {isPending
            ? t("quizChecking")
            : passed
              ? t("quizAllCorrect")
              : feedback && mode === "exam"
                ? t("quizExamNotPassed")
                : feedback && mode === "quizGate" && wrong > 0
                  ? t("quizSomeWrong", { count: wrong })
                  : null}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error === QUIZ_CONTENT_INVALID
            ? t("quizContentInvalid")
            : error === "quizFailed"
              ? t("quizNotPassed")
              : isSharedErrorCode(error)
                ? tErrors(error)
                : t("quizCheckFailed")}
        </p>
      )}
    </section>
  );
}
