"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

/**
 * Two-state light/dark switch (FX31, owner default). It flips the theme
 * the page SHOWS (`resolvedTheme`): the default theme is "system", so
 * toggling on `theme` made the first click a no-op for everyone whose
 * system was already dark ("system" → "dark"). The first click stores an
 * explicit choice; returning to "follow the system" would need a 3-state
 * control.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const t = useTranslations("theme");
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("toggle")}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      // Match the h-9 rounded-xl bordered row of topbar controls
      // (search trigger, locale switcher, notification bell).
      className="h-9 w-9 border bg-muted/40 hover:bg-muted/60"
    >
      <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
    </Button>
  );
}
