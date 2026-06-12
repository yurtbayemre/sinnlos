"use client";

import { useLocale } from "next-intl";
import { useTransition } from "react";
import { switchLocale } from "@/lib/locale-actions";
import type { Locale } from "@/i18n/locale";

const LABELS: Record<string, string> = {
  en: "EN",
  de: "DE",
};

export function LocaleSwitcher() {
  const current = useLocale();
  const [isPending, startTransition] = useTransition();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    startTransition(() => {
      switchLocale(e.target.value as Locale);
    });
  };

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={isPending}
      aria-label="Language"
      className="h-9 rounded-lg border bg-background px-2 text-xs font-medium text-muted-foreground outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {Object.entries(LABELS).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}
