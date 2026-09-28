"use client";

import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

import { useHydrated } from "@/lib/use-hydrated";

/**
 * Thin indeterminate progress bar rendered at the top of the viewport
 * whenever Next.js is loading a new route segment. Used from the route
 * loading.tsx files so it shows on every navigation between app pages.
 *
 * Portaled to <body> (defense in depth): loading.tsx renders inside
 * PageFade, and a transformed ancestor is the containing block of `fixed`
 * descendants. Since UI01 PageFade's fade-in-up leaves no transform behind
 * (fill mode `backwards`), but the transform still exists while the
 * animation runs, which is exactly when a loading state shows; without the
 * portal the bar would stick to the content column instead of the
 * viewport. Renders null before mount (SSR has no document to portal into).
 */
export function RouteProgress() {
  const tCommon = useTranslations("common");
  const hydrated = useHydrated();

  if (!hydrated) return null;

  return createPortal(
    <div
      role="progressbar"
      aria-label={tCommon("loadingPage")}
      className="fixed left-0 right-0 top-0 z-[60] h-0.5 overflow-hidden bg-transparent"
    >
      <div className="absolute top-0 h-full rounded-full bg-primary/80 shadow-[0_0_8px_hsl(var(--primary)/0.6)] animate-indeterminate" />
    </div>,
    document.body,
  );
}
