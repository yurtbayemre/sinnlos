"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Field, FieldGroup, inputClass } from "./form-controls";

/**
 * The date inputs of the /manage form kit (deep-dive decision 06 §L4):
 * `<input type="date">` plus `<input type="time">`, never
 * `datetime-local` and never `new Date(value)` in the browser. The values
 * stay strings; the Server Action converts them in APP_TIME_ZONE in reject
 * mode (lib/manage/datetime.ts), so the browser's zone plays no part. The
 * zone is named under every date and time pair.
 */

/** A date and a time as one field (an instant: a start, an expiry, a schedule). */
export function DateTimeField({
  id,
  legend,
  hint,
  error,
  date,
  time,
  timeZone,
  required = false,
  disabled = false,
  onDateChange,
  onTimeChange,
}: {
  /** fieldInputId(form, field): the date input; the time input is `<id>-time`. */
  id: string;
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  date: string;
  time: string;
  timeZone: string;
  required?: boolean;
  disabled?: boolean;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
}) {
  const t = useTranslations("manage.common.fields");
  const zoneHint = t("timeZone", { zone: timeZone });
  // The inputs that take the focus carry the group's hint and error too
  // (FieldGroup's ids): a screen reader reads them on the control itself.
  const describedBy = [`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <FieldGroup
      id={id}
      legend={legend}
      hint={hint ? `${hint} ${zoneHint}` : zoneHint}
      error={error}
      required={required}
    >
      <div className="flex flex-wrap gap-3">
        <div className="min-w-0 flex-1 space-y-1 sm:max-w-56">
          <label htmlFor={id} className="block text-xs text-muted-foreground">
            {t("date")}
          </label>
          <input
            id={id}
            type="date"
            value={date}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            aria-required={required ? true : undefined}
            onChange={(event) => onDateChange(event.target.value)}
            className={inputClass}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1 sm:max-w-40">
          <label htmlFor={`${id}-time`} className="block text-xs text-muted-foreground">
            {t("time")}
          </label>
          <input
            id={`${id}-time`}
            type="time"
            value={time}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            aria-required={required ? true : undefined}
            onChange={(event) => onTimeChange(event.target.value)}
            className={inputClass}
          />
        </div>
      </div>
    </FieldGroup>
  );
}

/** A calendar day (an all-day event's day, a poll's closing day, a deadline). */
export function DayField({
  id,
  label,
  hint,
  error,
  value,
  min,
  required = false,
  disabled = false,
  className,
  onChange,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** `YYYY-MM-DD` or "". */
  value: string;
  /** The earliest day the picker offers (`YYYY-MM-DD`, in APP_TIME_ZONE). */
  min?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {(a11y) => (
        <input
          {...a11y}
          type="date"
          value={value}
          min={min}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(inputClass, "sm:max-w-56")}
        />
      )}
    </Field>
  );
}
