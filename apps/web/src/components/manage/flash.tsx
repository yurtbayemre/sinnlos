"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * The success messages of /manage ("Draft saved.", "Published.", …): one
 * polite live region for the whole shell, provided by the /manage layout,
 * so a message survives the navigation that follows a create (to the new
 * item's page) or a delete (to the list). Failures are not flashed: they
 * stay next to the form (role="alert"), with the fields they concern.
 *
 * The region is portaled to <body>: PageFade and the topbar are the
 * containing block of a `fixed` descendant (architecture §5.97). It sits
 * above the phone's tab bar, disappears after a few seconds and can be
 * dismissed. The live region itself is always in the DOM, so screen
 * readers pick up a message the moment it is set.
 */

type Flash = (message: string) => void;

const FlashContext = createContext<Flash>(() => undefined);

/** How long a message stays (ms). */
const FLASH_MS = 6000;

export function ManageFlashProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("manage.common.success");
  const [message, setMessage] = useState<{ text: string; key: number } | null>(null);
  const mounted = useHydrated();

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  const flash = useCallback<Flash>((text) => setMessage({ text, key: Date.now() }), []);

  return (
    <FlashContext.Provider value={flash}>
      {children}
      {mounted &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed inset-x-4 bottom-24 z-50 flex justify-center md:inset-x-auto md:bottom-6 md:right-6"
          >
            {message ? (
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
            ) : null}
          </div>,
          document.body,
        )}
    </FlashContext.Provider>
  );
}

/** Shows a success message in the /manage live region. */
export function useManageFlash(): Flash {
  return useContext(FlashContext);
}
