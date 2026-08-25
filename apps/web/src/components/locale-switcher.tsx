"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, ChevronDown, Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { switchLocale } from "@/lib/locale-actions";
import type { Locale } from "@/i18n/locale";

/* Full language names in their own language — the one label style that is
 * correct regardless of the currently active locale. */
const LOCALES: { value: Locale; short: string; label: string }[] = [
  { value: "de", short: "DE", label: "Deutsch" },
  { value: "en", short: "EN", label: "English" },
];

/* Custom dropdown instead of a native <select>: the opened native menu is
 * OS-drawn (square corners, foreign typography) and cannot be styled to
 * match the site. Same pattern as notifications/notification-bell.tsx.
 * The panel uses `absolute` — safe inside the blurred topbar; only `fixed`
 * children are broken by its backdrop-filter containing block. */
export function LocaleSwitcher() {
  const t = useTranslations("localeSwitcher");
  const current = useLocale();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
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

  const active = LOCALES.find((l) => l.value === current) ?? LOCALES[0];

  const select = (value: Locale) => {
    setOpen(false);
    if (value === current) return;
    startTransition(() => {
      switchLocale(value);
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("label")}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={isPending}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1 rounded-xl border bg-muted/40 px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Languages aria-hidden="true" className="h-4 w-4" />
        <span>{active.short}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-3 w-3 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t("label")}
          className="absolute right-0 top-full z-50 mt-2 w-36 animate-scale-in overflow-hidden rounded-xl border bg-background p-1 shadow-lg"
        >
          {LOCALES.map((l) => (
            <button
              key={l.value}
              type="button"
              role="option"
              aria-selected={l.value === current}
              onClick={() => select(l.value)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            >
              <span className="flex-1 text-left">{l.label}</span>
              {l.value === current && <Check aria-hidden="true" className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
