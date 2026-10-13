"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * The success messages of /manage ("Draft saved.", "Published.", …): one
 * polite live region for the whole shell, so a message survives the
 * navigation that follows a create (to the new item's page) or a delete
 * (to the list). Failures are not flashed: they stay next to the form
 * (role="alert"), with the fields they concern.
 *
 * Why module state and a region outside React: the app shell's PageFade
 * remounts the whole page subtree on every pathname change (its fade-in
 * key), the /manage layout included, so React state there would be lost
 * on exactly the navigations this is for. The message lives in a small
 * store in this module (client navigations keep the module), and the live
 * region is one element appended to <body> once: a screen reader
 * announces a change of its content, which a region remounted with the
 * text already in it would not. The provider renders the message into it
 * (a portal: PageFade and the topbar would be the containing block of a
 * `fixed` descendant, architecture §5.97). It sits above the phone's tab
 * bar, disappears after a few seconds and can be dismissed.
 */

/** How long a message stays (ms). */
const FLASH_MS = 6000;

type Message = { text: string; key: number } | null;

let current: Message = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setMessage(next: Message) {
  current = next;
  if (timer) clearTimeout(timer);
  timer = next ? setTimeout(() => setMessage(null), FLASH_MS) : undefined;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Shows `text` in the /manage live region. */
export function showFlash(text: string): void {
  setMessage({ text, key: Date.now() });
}

let region: HTMLElement | null = null;

/** The one live region, created on first use and kept across remounts. */
function liveRegion(): HTMLElement {
  if (region && document.body.contains(region)) return region;
  region = document.createElement("div");
  region.id = "manage-flash";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  region.className =
    "pointer-events-none fixed inset-x-4 bottom-24 z-50 flex justify-center md:inset-x-auto md:bottom-6 md:right-6";
  document.body.appendChild(region);
  return region;
}

export function ManageFlashProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("manage.common.success");
  const message = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  const hydrated = useHydrated();
  return (
    <>
      {children}
      {hydrated &&
        createPortal(
          message ? (
            <div
              key={message.key}
              className="pointer-events-auto flex max-w-md animate-scale-in items-center gap-3 rounded-xl border bg-background px-4 py-3 text-sm shadow-lg"
            >
              <CheckCircle2
                className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">{message.text}</span>
              <button
                type="button"
                onClick={() => setMessage(null)}
                aria-label={t("dismiss")}
                className="rounded-lg p-1 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ) : null,
          liveRegion(),
        )}
    </>
  );
}

/** Shows a success message in the /manage live region. */
export function useManageFlash(): (text: string) => void {
  return showFlash;
}
