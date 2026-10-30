"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useLiveRegistry } from "./live-events-provider";

/**
 * The header's "live updates delayed" note (batch 13 merge, 8C-T01): the
 * live stream runs but is unhealthy (LF05 two-leg health: the cms leg is
 * stale, the channel set was refused, or the client stopped retrying), so
 * the comment sections and the bell poll at their short intervals instead
 * of waiting for pings.
 *
 * Shown only after the stream has been unhealthy for
 * DEGRADED_NOTICE_DELAY_MS while the tab is visible: every page load and
 * every visibility regain starts unhealthy until the hello arrives (about a
 * second), and a hidden tab holds no stream on purpose. A stopped cms
 * therefore shows within EMIT_FRESH_MS plus one heartbeat plus this delay
 * (at most 75 s); a fresh heartbeat hides it at once. Without a stream at
 * all (LIVE_EVENTS_DISABLED=1, DEMO_MODE) polling is the normal mode and
 * nothing shows.
 */
export const DEGRADED_NOTICE_DELAY_MS = 5_000;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const isVisible = () => document.visibilityState === "visible";

/** Whether the header shows the note now (see DEGRADED_NOTICE_DELAY_MS). */
export function useDegradedNotice(): boolean {
  const { streaming, healthy } = useLiveRegistry();
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, () => true);
  const degraded = streaming && !healthy && visible;
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!degraded) return;
    const timer = setTimeout(() => setShown(true), DEGRADED_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [degraded]);

  return degraded && shown;
}

/**
 * The note itself. The status region is always rendered (empty while the
 * stream is fine), so screen readers announce the text when it appears.
 * The label is visible from xl and read out below it; the hint is the
 * pill's tooltip.
 *
 * A newer web build (#214) takes the place of the delayed note: the tab's
 * Server Actions are gone, so it offers a reload, never by itself (an
 * editor may hold unsaved input; its beforeunload guard still asks). Below
 * xl it is a square icon button like the header's other h-9 controls, so a
 * 360 px phone keeps its width (topbar.tsx PHONE_ICON_BUTTON).
 */
export function LiveStatusView({
  degraded,
  newVersion = false,
}: {
  degraded: boolean;
  newVersion?: boolean;
}) {
  const t = useTranslations("live");
  return (
    <div role="status" aria-live="polite" className="flex items-center">
      {newVersion ? (
        <button
          type="button"
          title={t("newVersionHint")}
          onClick={() => window.location.reload()}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-0 text-xs xl:w-auto xl:px-2.5 font-medium text-amber-700 outline-hidden hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:text-amber-300"
        >
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="sr-only xl:not-sr-only xl:whitespace-nowrap">{t("newVersion")}</span>
        </button>
      ) : (
        degraded && (
          <span
            title={t("delayedHint")}
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
          >
            <WifiOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="sr-only xl:not-sr-only xl:whitespace-nowrap">{t("delayed")}</span>
          </span>
        )
      )}
    </div>
  );
}

/** The header's live status, from the page's LiveEventsProvider. */
export function LiveStatus() {
  const { newVersion } = useLiveRegistry();
  return <LiveStatusView degraded={useDegradedNotice()} newVersion={newVersion} />;
}
