"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * The field primitives of the /manage form kit (deep-dive decision 06 §L4;
 * batch 15 plan, lane 15C item 2). Every control has a visible label tied
 * to it, its hint and its error are wired as the control's description
 * (aria-describedby), an error sets aria-invalid, and a required control
 * says so to assistive technology (aria-required) and visually.
 *
 * Ids follow lib/manage/errors.ts: a field's control is `<formId>-<field>`
 * (fieldInputId), its error `<formId>-<field>-error` (fieldErrorId), so a
 * form can move the focus to the first field the cms refused.
 */

export const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring aria-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:opacity-60";

export const textareaClass =
  "min-h-40 w-full rounded-xl border bg-muted/40 px-3 py-2 font-mono text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring aria-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:opacity-60";

const checkboxClass =
  "mt-0.5 h-4 w-4 shrink-0 rounded border accent-primary disabled:cursor-not-allowed";

/** The attributes a control gets from its field. */
export interface ControlA11y {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

const describedBy = (...ids: (string | false | null | undefined)[]): string | undefined =>
  ids.filter(Boolean).join(" ") || undefined;

/** The visual "required" marker; the control itself carries aria-required. */
function RequiredMark() {
  const t = useTranslations("manage.common.fields");
  return (
    <span className="ml-1 text-destructive" title={t("required")} aria-hidden="true">
      *
    </span>
  );
}

/** A field's error text (an alert-free paragraph; the form announces the failure once). */
export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {children}
    </p>
  );
}

/** One labelled control: the label, the control (render prop), its hint and its error. */
export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: {
  /** The control's id (fieldInputId). */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** The error text, or nothing. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: (a11y: ControlA11y) => ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required && <RequiredMark />}
      </label>
      {children({
        id,
        "aria-describedby": describedBy(hint ? hintId : null, error ? errorId : null),
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

/**
 * A group of controls under one legend (a date and a time, a checkbox
 * list). The hint and the error describe the group, so a screen reader
 * reads them on entering it.
 */
export function FieldGroup({
  id,
  legend,
  hint,
  error,
  required = false,
  className,
  children,
}: {
  /** The group's id; the error is `<id>-error` (fieldErrorId when id is fieldInputId). */
  id: string;
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <fieldset
      id={`${id}-group`}
      aria-describedby={describedBy(hint ? hintId : null, error ? errorId : null)}
      aria-invalid={error ? true : undefined}
      className={cn("min-w-0 space-y-2", className)}
    >
      <legend className="text-sm font-medium">
        {legend}
        {required && <RequiredMark />}
      </legend>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children}
      <FieldError id={errorId}>{error}</FieldError>
    </fieldset>
  );
}

/** A labelled checkbox with an optional hint and error. */
export function CheckboxField({
  id,
  label,
  hint,
  error,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={describedBy(hint ? hintId : null, error ? errorId : null)}
          aria-invalid={error ? true : undefined}
          className={checkboxClass}
        />
        <div className="min-w-0">
          <label htmlFor={id} className={cn("text-sm font-medium", disabled && "opacity-60")}>
            {label}
          </label>
          {hint ? (
            <p id={hintId} className="text-xs text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

/** One option of a CheckboxList. */
export interface CheckOption {
  value: string;
  label: string;
}

/**
 * A multiple choice as native checkboxes (departments, role types; UI02 is
 * for single choices). `selected` keeps the order of `options`; a selected
 * value without an option (a department deleted meanwhile, a role the
 * form does not offer) stays selected and is listed by its value.
 */
export function CheckboxList({
  id,
  legend,
  hint,
  error,
  options,
  selected,
  disabled,
  emptyText,
  onChange,
}: {
  id: string;
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  options: readonly CheckOption[];
  selected: readonly string[];
  disabled?: boolean;
  /** Shown instead of the list when there are no options. */
  emptyText?: ReactNode;
  onChange: (selected: string[]) => void;
}) {
  const known = new Set(options.map((option) => option.value));
  const extra = selected.filter((value) => !known.has(value));
  const all: CheckOption[] = [...options, ...extra.map((value) => ({ value, label: value }))];
  const toggle = (value: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(value);
    else next.delete(value);
    onChange(all.map((option) => option.value).filter((value) => next.has(value)));
  };
  return (
    <FieldGroup id={id} legend={legend} hint={hint} error={error}>
      {all.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {all.map((option, i) => {
            const optionId = i === 0 ? id : `${id}-${i}`;
            return (
              <div key={option.value} className="flex items-start gap-2.5">
                <input
                  id={optionId}
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  disabled={disabled}
                  onChange={(event) => toggle(option.value, event.target.checked)}
                  className={checkboxClass}
                />
                <label
                  htmlFor={optionId}
                  className={cn("min-w-0 break-words text-sm", disabled && "opacity-60")}
                >
                  {option.label}
                </label>
              </div>
            );
          })}
        </div>
      )}
    </FieldGroup>
  );
}
