"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * True once the client has hydrated, false during SSR and the hydration
 * render. Store-based replacement for the mounted-flag effect (issue
 * #36): components that portal to document.body must render null on the
 * server, but `useEffect(() => setMounted(true))` is a synchronous
 * setState-in-effect and costs an extra render pass after hydration —
 * with the store snapshot, purely client-side renders (route
 * navigations) get `true` on the very first pass.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
