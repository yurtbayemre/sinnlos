"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_QUESTIONS,
  QUIZ_MAX_TEXT,
  validateQuiz,
  type QuizQuestion,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { Field, FieldError, inputClass } from "./form-controls";

/** Removing an option preserves the chosen answer by index, or requires a new choice. */
export function removeQuizOption(question: QuizQuestion, index: number): QuizQuestion {
  return {
    ...question,
    options: question.options.filter((_, i) => i !== index),
    correctIndex:
      question.correctIndex === index
        ? -1
        : question.correctIndex > index
          ? question.correctIndex - 1
          : question.correctIndex,
  };
}

/**
 * Which parts of one question the shared validator (validateQuiz) refuses:
 * the question text, each answer, the number of answers (only old or
 * panel-written rows can break it; the form keeps 2–QUIZ_MAX_OPTIONS), the
 * missing correct answer. The builder marks only these, never the whole
 * quiz. Too many questions has no field: the quiz-wide error names the
 * limits.
 */
export function questionProblems(question: QuizQuestion): {
  question: boolean;
  options: boolean[];
  count: boolean;
  correct: boolean;
} {
  const bad = (text: unknown) =>
    typeof text !== "string" || text.trim() === "" || text.length > QUIZ_MAX_TEXT;
  return {
    question: bad(question.question),
    options: question.options.map(bad),
    count: question.options.length < 2 || question.options.length > QUIZ_MAX_OPTIONS,
    correct:
      !Number.isInteger(question.correctIndex) ||
      question.correctIndex < 0 ||
      question.correctIndex >= question.options.length,
  };
}

export function QuizBuilder({
  id,
  value,
  onChange,
  disabled = false,
  error,
}: {
  id: string;
  value: QuizQuestion[];
  onChange: (quiz: QuizQuestion[]) => void;
  disabled?: boolean;
  error?: string;
}) {
  const t = useTranslations("manage.training.quiz");
  const root = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  // Checked since the last added question or answer ("Check quiz", or a
  // save the cms refused, whose error arrives as `error`): a field added
  // afterwards stays unmarked until the next check or save.
  const [checked, setChecked] = useState(false);
  const [seenError, setSeenError] = useState<string | undefined>(undefined);
  let marking = checked;
  if (error !== seenError) {
    setSeenError(error);
    if (error) {
      setChecked(true);
      marking = true;
    }
  }
  const valid = !("error" in validateQuiz(value));
  // The form and the cms check with the same validateQuiz, so a refusal of a
  // quiz that is valid now is stale (fixed since): it is no longer shown.
  const shownError = valid ? undefined : error || (checked ? t("invalid") : undefined);
  const problems = marking ? value.map(questionProblems) : null;
  // The first question is the editor's focus target for a quiz error, so it
  // always carries the error's description.
  const describedBy = (invalidField: boolean) =>
    `${id}-hint${shownError && invalidField ? ` ${id}-error` : ""}`;
  const edit = (index: number, question: QuizQuestion) =>
    onChange(value.map((q, i) => (i === index ? question : q)));
  const focusAfter = (target: string) =>
    requestAnimationFrame(() => {
      const control = root.current?.querySelector<HTMLElement>(`[id="${target}"]`);
      control?.focus();
    });
  return (
    <div ref={root} className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t("title")}</h3>
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {t("limits", {
            questions: QUIZ_MAX_QUESTIONS,
            options: QUIZ_MAX_OPTIONS,
            characters: QUIZ_MAX_TEXT,
          })}
        </p>
      </div>
      <FieldError id={`${id}-error`}>{shownError}</FieldError>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {value.map((question, q) => (
        <fieldset key={q} disabled={disabled} className="space-y-3 rounded-xl border p-4">
          <legend className="px-1 text-sm font-semibold">
            {t("questionNumber", { number: q + 1 })}
          </legend>
          <Field id={q === 0 ? id : `${id}-question-${q}`} label={t("questionText")} required>
            {(a11y) => (
              <input
                {...a11y}
                aria-describedby={describedBy(q === 0 || !!problems?.[q].question)}
                aria-invalid={problems?.[q].question ? true : undefined}
                value={question.question}
                maxLength={QUIZ_MAX_TEXT}
                className={inputClass}
                onChange={(e) => edit(q, { ...question, question: e.target.value })}
              />
            )}
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{t("correctAnswer")}</legend>
            <FieldError id={`${id}-correct-${q}-error`}>
              {problems?.[q].count
                ? t("answerCount", { options: QUIZ_MAX_OPTIONS })
                : problems?.[q].correct
                  ? t("chooseCorrectMissing")
                  : undefined}
            </FieldError>
            {question.options.map((option, o) => (
              <div key={o} className="flex items-end gap-2">
                <label className="flex h-10 shrink-0 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${id}-correct-${q}`}
                    checked={question.correctIndex === o}
                    onChange={() => edit(q, { ...question, correctIndex: o })}
                    aria-describedby={
                      problems?.[q].correct ? `${id}-correct-${q}-error` : undefined
                    }
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="sr-only">{t("chooseCorrect", { number: o + 1 })}</span>
                </label>
                <Field
                  id={`${id}-option-${q}-${o}`}
                  label={t("optionNumber", { number: o + 1 })}
                  className="min-w-0 flex-1"
                  required
                >
                  {(a11y) => (
                    <input
                      {...a11y}
                      aria-invalid={problems?.[q].options[o] ? true : undefined}
                      aria-describedby={problems?.[q].options[o] ? `${id}-error` : undefined}
                      maxLength={QUIZ_MAX_TEXT}
                      value={option}
                      className={inputClass}
                      onChange={(e) =>
                        edit(q, {
                          ...question,
                          options: question.options.map((text, i) =>
                            i === o ? e.target.value : text,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled || question.options.length <= 2}
                  aria-label={t("removeOptionNumber", { number: o + 1 })}
                  onClick={() => {
                    edit(q, removeQuizOption(question, o));
                    setAnnouncement(t("optionRemoved"));
                    focusAfter(`${id}-option-${q}-${Math.max(0, o - 1)}`);
                  }}
                >
                  {t("remove")}
                </Button>
              </div>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={disabled || question.options.length >= QUIZ_MAX_OPTIONS}
              onClick={() => {
                edit(q, { ...question, options: [...question.options, ""] });
                setChecked(false);
                setAnnouncement(t("optionAdded"));
                focusAfter(`${id}-option-${q}-${question.options.length}`);
              }}
            >
              {t("addOption")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onChange(value.filter((_, i) => i !== q));
                setAnnouncement(t("questionRemoved"));
                focusAfter(q <= 1 ? id : `${id}-question-${q - 1}`);
              }}
            >
              {t("removeQuestion")}
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          id={value.length === 0 ? id : `${id}-add`}
          type="button"
          variant="outline"
          disabled={disabled || value.length >= QUIZ_MAX_QUESTIONS}
          aria-describedby={describedBy(true)}
          onClick={() => {
            onChange([...value, { question: "", options: ["", ""], correctIndex: -1 }]);
            setChecked(false);
            setAnnouncement(t("questionAdded"));
            focusAfter(value.length === 0 ? id : `${id}-question-${value.length}`);
          }}
        >
          {t("addQuestion")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setChecked(true);
            setAnnouncement(valid ? t("valid") : t("invalid"));
          }}
        >
          {t("validate")}
        </Button>
      </div>
      {checked && valid && value.length > 0 && (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">{t("valid")}</p>
      )}
      {value.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
    </div>
  );
}
