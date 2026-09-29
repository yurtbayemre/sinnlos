"use client";

import { useTransition } from "react";
import { Languages } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { SelectMenu } from "@/components/ui/select-menu";
import { switchLocale } from "@/lib/locale-actions";
import type { Locale } from "@/i18n/locale";

/* Full language names in their own language — the one label style that is
 * correct regardless of the currently active locale. */
const LOCALES: { value: Locale; short: string; label: string }[] = [
  { value: "de", short: "DE", label: "Deutsch" },
  { value: "en", short: "EN", label: "English" },
];

/**
 * The topbar's language menu, on the shared SelectMenu (UI02): Radix
 * DropdownMenu with keyboard navigation, typeahead and focus return, the
 * panel portaled out of the blurred topbar. The closed trigger shows the
 * short code; its accessible name is "<label> <language>".
 *
 * The switch is awaited inside the transition, so the trigger stays
 * disabled until switchLocale has set the cookie and the page came back in
 * the new language (it used to re-enable as soon as the call started). A
 * failed call (the web server unreachable) keeps the current language
 * instead of replacing the page with the error boundary; Next's control
 * flow (the sign-in redirect of an expired session) is rethrown.
 */
export function LocaleSwitcher() {
  const t = useTranslations("localeSwitcher");
  const current = useLocale();
  const [isPending, startTransition] = useTransition();

  const select = (value: string) => {
    const next = LOCALES.find((l) => l.value === value);
    if (!next || next.value === current) return;
    startTransition(async () => {
      try {
        await switchLocale(next.value);
      } catch (error) {
        unstable_rethrow(error);
        // Nothing switched: the menu keeps showing the current language.
      }
    });
  };

  return (
    <SelectMenu
      value={current}
      onChange={select}
      options={LOCALES}
      ariaLabel={t("label")}
      align="right"
      disabled={isPending}
      icon={<Languages aria-hidden="true" className="h-4 w-4 shrink-0" />}
      buttonClassName="h-9 gap-1 px-2.5 text-xs font-medium text-muted-foreground"
      panelClassName="w-36"
    />
  );
}
