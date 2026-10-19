"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Keeps <meta name="theme-color"> on the page's current background, so the
 * status bar of the installed app follows the app's light/dark switch, not
 * the phone's system mode (v0.17.6). It watches <html>'s class and style,
 * which next-themes sets, instead of the theme state: next-themes applies
 * the class in its own effect, after a child's effect would have run.
 * Each change inserts a new element instead of editing the old one's
 * content: iOS kept the launch colour while the app was open (v0.17.7).
 */
function ThemeColorMeta() {
  React.useEffect(() => {
    const sync = () => {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = getComputedStyle(document.body).backgroundColor;
      const old = document.querySelector('meta[name="theme-color"]');
      if (old) old.replaceWith(meta);
      else document.head.append(meta);
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
