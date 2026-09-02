"use client";

import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import type { QuizQuestion } from "@/lib/training-shared";

/**
 * Self-check quiz (issue #29): client-only, answers are NEVER persisted
 * and passing is NOT a completion requirement (product decision — the
 * correctIndex being API-readable is accepted for the same reason).
 * State is per-question: pick an option → immediate right/wrong
 * feedback, retry allowed.
 */
export function QuizBlock({ quiz }: { quiz: QuizQuestion[] }) {
  const t = useTranslations("training");
  const [answers, setAnswers] = useState<Record<number, number>>({});

  if (quiz.length === 0) return null;

  return (
    <section className="space-y-4 rounded-xl border p-4">
      <h2 className="text-sm font-medium text-muted-foreground">{t("quizTitle")}</h2>
      {quiz.map((q, qi) => {
        const picked = answers[qi];
        return (
          <div key={qi} className="space-y-2">
            <div className="text-sm font-medium">{q.question}</div>
            <div className="grid gap-2">
              {q.options.map((option, oi) => {
                const isPicked = picked === oi;
                const isCorrect = oi === q.correctIndex;
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => setAnswers((a) => ({ ...a, [qi]: oi }))}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                      isPicked
                        ? isCorrect
                          ? "border-emerald-500/60 bg-emerald-500/10"
                          : "border-red-500/60 bg-red-500/10"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <span>{option}</span>
                    {isPicked &&
                      (isCorrect ? (
                        <CheckCircle2
                          className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <XCircle
                          className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
                          aria-hidden="true"
                        />
                      ))}
                  </button>
                );
              })}
            </div>
            {picked !== undefined && (
              <p
                className={`text-xs ${
                  picked === q.correctIndex
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {picked === q.correctIndex ? t("quizCorrect") : t("quizWrong")}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
