"use client";

import { useId, type ReactNode, type Ref } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectMenuOption = {
  value: string;
  label: string;
  /**
   * Shorter text for the closed trigger (the locale switcher's "EN"); the
   * accessible name and the open menu use `label`.
   */
  short?: string;
};

type SelectMenuProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  ariaLabel: string;
  /**
   * When set, a hidden input carries the current value in the surrounding
   * form's FormData — the custom trigger button itself submits nothing.
   */
  name?: string;
  /** Panel edge to align with the trigger (default left). */
  align?: "left" | "right";
  buttonClassName?: string;
  panelClassName?: string;
  /** Shown before the value in the trigger (decorative). */
  icon?: ReactNode;
  disabled?: boolean;
  /**
   * Work started from the menu is still running (the locale switch): the
   * trigger shows it (aria-busy, dimmed) but stays enabled, so Radix can
   * give focus back to it when the menu closes. A disabled trigger cannot
   * take focus, and the focus would end on <body>.
   */
  busy?: boolean;
  /** The trigger button (React 19: a plain prop, no forwardRef). */
  ref?: Ref<HTMLButtonElement>;
};

/**
 * Custom dropdown replacement for native <select> (UI02): the opened native
 * menu is OS-drawn and cannot be styled to match the site. Built on Radix
 * DropdownMenu, which brings what the hand-rolled panel lacked: arrow-key
 * roving focus, typeahead on the option labels, Escape and outside-click
 * close, and focus back on the trigger when the menu closes. The options
 * are a radio group (menuitemradio with aria-checked).
 *
 * The panel is portaled to <body>: the sticky topbar's backdrop-filter and
 * PageFade's animation make their elements the containing block of `fixed`
 * descendants, and Radix positions the panel with `fixed`.
 *
 * Accessible name: "<ariaLabel> <current label>" (aria-labelledby on two
 * hidden spans), so a screen reader hears the current value on the trigger
 * as a native select would; the menu itself is named by `ariaLabel`.
 *
 * Contract kept for classified-form and people-grid: the props and the
 * hidden input (`name`) that puts the value into the form's FormData — it
 * sits next to the trigger, never in the portal, so it stays in the form.
 *
 * Focus return needs an enabled trigger: Radix focuses it when the menu
 * closes (after an option was picked, too). A caller whose onChange starts
 * work passes `busy`, not `disabled`, for that time (the locale switcher).
 */
export function SelectMenu({
  value,
  onChange,
  options,
  ariaLabel,
  name,
  align = "left",
  buttonClassName,
  panelClassName,
  icon,
  disabled,
  busy = false,
  ref,
}: SelectMenuProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const active = options.find((o) => o.value === value);

  const select = (next: string) => {
    if (next !== value) onChange(next);
  };

  return (
    <DropdownMenu.Root>
      {name && <input type="hidden" name={name} value={value} />}
      <span id={labelId} hidden>
        {ariaLabel}
      </span>
      <span id={valueId} hidden>
        {active?.label}
      </span>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          ref={ref}
          type="button"
          aria-labelledby={`${labelId} ${valueId}`}
          aria-busy={busy || undefined}
          className={cn(
            "group flex h-10 items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 aria-busy:opacity-50",
            buttonClassName,
          )}
        >
          {icon}
          <span className="truncate">{active?.short ?? active?.label}</span>
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-180"
          />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-labelledby={labelId}
          align={align === "right" ? "end" : "start"}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            "z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-max min-w-[var(--radix-dropdown-menu-trigger-width)] animate-scale-in overflow-y-auto rounded-xl border bg-background p-1 shadow-lg",
            panelClassName,
          )}
        >
          <DropdownMenu.RadioGroup value={value} onValueChange={select}>
            {options.map((o) => (
              <DropdownMenu.RadioItem
                key={o.value}
                value={o.value}
                textValue={o.label}
                className="flex w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <span className="flex-1 truncate text-left">{o.label}</span>
                <DropdownMenu.ItemIndicator>
                  <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
