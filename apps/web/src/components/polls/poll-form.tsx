"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { createPoll, type CreatePollErrorCode } from "@/lib/poll-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const MAX_OPTIONS = 10;

/** Poll creation form. Options are plain text fields (one per answer) —
 * the JSON array the CMS stores is assembled by the server action. All
 * fields are controlled state, so nothing is lost when an action returns
 * an error (React 19 resets uncontrolled <form action> fields). */
export function PollForm({ departments }: { departments: { id: number; name: string }[] }) {
  const t = useTranslations("polls");
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [closesAt, setClosesAt] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [departmentIds, setDepartmentIds] = useState<number[]>([]);
  const [error, setError] = useState<CreatePollErrorCode | null>(null);
  const [isPending, startTransition] = useTransition();

  const setOption = (i: number, value: string) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
  const removeOption = (i: number) => setOptions((prev) => prev.filter((_, idx) => idx !== i));
  const toggleDepartment = (id: number) =>
    setDepartmentIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));

  const today = new Date().toISOString().slice(0, 10);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createPoll({ question, options, closesAt, anonymous, departmentIds });
      if (result.ok) {
        router.push("/polls");
      } else {
        setError(result.code);
      }
    });
  };

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <div className="space-y-1.5">
        <label htmlFor="poll-question" className="text-sm font-medium">
          {t("formQuestion")}
        </label>
        <input
          id="poll-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("formQuestionPlaceholder")}
          maxLength={200}
          required
          className={inputClass}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("formOptions")}</legend>
        <p className="text-xs text-muted-foreground">{t("formOptionsHint")}</p>
        {options.map((option, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={option}
              onChange={(e) => setOption(i, e.target.value)}
              placeholder={t("formOptionPlaceholder", { number: i + 1 })}
              aria-label={t("formOptionPlaceholder", { number: i + 1 })}
              maxLength={120}
              className={inputClass}
            />
            {options.length > 2 && (
              <button
                type="button"
                onClick={() => removeOption(i)}
                aria-label={t("formRemoveOption", { number: i + 1 })}
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive",
                  focusRing,
                )}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        {options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => setOptions((prev) => [...prev, ""])}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
              focusRing,
            )}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("formAddOption")}
          </button>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <label htmlFor="poll-closes" className="text-sm font-medium">
          {t("formClosesAt")}
        </label>
        <input
          id="poll-closes"
          type="date"
          value={closesAt}
          min={today}
          onChange={(e) => setClosesAt(e.target.value)}
          className={cn(inputClass, "sm:max-w-56")}
        />
        <p className="text-xs text-muted-foreground">{t("formClosesAtHint")}</p>
      </div>

      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={anonymous}
          onChange={(e) => setAnonymous(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border accent-primary"
        />
        <span>
          <span className="block text-sm font-medium">{t("formAnonymous")}</span>
          <span className="block text-xs text-muted-foreground">{t("formAnonymousHint")}</span>
        </span>
      </label>

      {departments.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("formDepartments")}</legend>
          <p className="text-xs text-muted-foreground">{t("formDepartmentsHint")}</p>
          <div className="flex flex-wrap gap-2">
            {departments.map((d) => (
              <button
                key={d.id}
                type="button"
                role="checkbox"
                aria-checked={departmentIds.includes(d.id)}
                onClick={() => toggleDepartment(d.id)}
                className={cn(
                  "rounded-xl border px-3 py-1.5 text-sm transition-colors",
                  focusRing,
                  departmentIds.includes(d.id)
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {d.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`formError_${error}`)}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className={cn(
            "rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50",
            focusRing,
          )}
        >
          {isPending ? t("formCreating") : t("formSubmit")}
        </button>
        <button
          type="button"
          onClick={() => router.push("/polls")}
          className={cn(
            "rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted/60",
            focusRing,
          )}
        >
          {t("formCancel")}
        </button>
      </div>
    </form>
  );
}
