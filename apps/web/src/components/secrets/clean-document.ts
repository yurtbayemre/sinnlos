"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * A secret is typed or shown only in a document that never loaded the
 * Plausible script (v0.35, plan §3.10). The root layout renders it no more
 * while the module secrets is on, but a tab opened while secrets was off
 * keeps the executed script across client navigation (nav, bell, links,
 * history). Such a document is reloaded: the fresh one has no analytics.
 */
export function documentHasAnalytics(): boolean {
  return "plausible" in window || document.querySelector("script[data-domain]") !== null;
}

const subscribe = () => () => {};

/**
 * True once this document is known to be clean: false in the server render
 * and in a document with analytics, which it reloads.
 */
export function useCleanDocument(): boolean {
  const clean = useSyncExternalStore(
    subscribe,
    () => !documentHasAnalytics(),
    () => false,
  );
  useEffect(() => {
    if (documentHasAnalytics()) window.location.reload();
  }, []);
  return clean;
}
