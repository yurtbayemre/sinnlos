"use client";

import type { ReactNode } from "react";
import { SelectMenu, type SelectMenuOption } from "@/components/ui/select-menu";
import { cn } from "@/lib/utils";
import { FieldError } from "./form-controls";

/**
 * A single choice of the /manage forms on the UI02 SelectMenu (decision 06
 * §L4: department, team, icon, category). The menu brings the keyboard
 * (arrows, typeahead, Escape) and names its trigger "<label> <value>"; the
 * hint and the error describe the trigger itself (its aria-describedby), so
 * a screen reader reads them with it, also when a refused field moves the
 * focus there. The visible label names a group around the menu, which
 * carries the field's id (fieldInputId): a refused field moves the focus to
 * the first control inside it, the trigger.
 */
export function SinglePicker({
  id,
  label,
  hint,
  error,
  value,
  options,
  disabled = false,
  className,
  onChange,
}: {
  id: string;
  /** Also the menu's accessible name. */
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  value: string;
  options: SelectMenuOption[];
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <span id={labelId} className="block text-sm font-medium">
        {label}
      </span>
      <div id={id} role="group" aria-labelledby={labelId}>
        <SelectMenu
          value={value}
          onChange={onChange}
          options={options}
          ariaLabel={label}
          disabled={disabled}
          ariaDescribedBy={describedBy}
          buttonClassName={cn("w-full sm:w-80", error && "border-destructive")}
          panelClassName="max-w-[calc(100vw-1.5rem)]"
        />
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
