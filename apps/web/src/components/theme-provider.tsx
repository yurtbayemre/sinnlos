"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Keeps <meta name="theme-color"> on the page's current background, so the
 * status bar of the installed app follows the app's light/dark switch, not
 * the phone's system mode (v0.17.6). It watches <html>'s class and style,
 * which next-themes sets, instead of the theme state: next-themes applies
 * the class in its own effect, after a child's effect would have run.
 */
function ThemeColorMeta() {
  React.useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const meta = existing ?? document.createElement("meta");
    if (!existing) {
      meta.name = "theme-color";
      document.head.append(meta);
    }
    const sync = () => {
      meta.content = getComputedStyle(document.body).backgroundColor;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return null;
}

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider {...props}>
      <ThemeColorMeta />
      {children}
    </NextThemesProvider>
  );
}
