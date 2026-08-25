"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectMenuOption = { value: string; label: string };

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
};

/**
 * Custom dropdown replacement for native <select> (locale-switcher pattern):
 * the opened native menu is OS-drawn and cannot be styled to match the site.
 * The panel uses `absolute` — safe under ancestors with backdrop-filter or a
 * persistent transform (they only turn into containing blocks for `fixed`
 * descendants, the documented portal trap).
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
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const active = options.find((o) => o.value === value);

  const select = (next: string) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div ref={ref} className="relative">
      {name && <input type="hidden" name={name} value={value} />}
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-10 items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          buttonClassName,
        )}
      >
        <span className="truncate">{active?.label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "absolute top-full z-50 mt-2 w-max min-w-full animate-scale-in overflow-hidden rounded-xl border bg-background p-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => select(o.value)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="flex-1 truncate text-left">{o.label}</span>
              {o.value === value && (
                <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
