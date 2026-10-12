"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";
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
 */
export function LiveStatusView({ degraded }: { degraded: boolean }) {
  const t = useTranslations("live");
  return (
    <div role="status" aria-live="polite" className="flex items-center">
      {degraded && (
        <span
          title={t("delayedHint")}
          className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
        >
          <WifiOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="sr-only xl:not-sr-only xl:whitespace-nowrap">{t("delayed")}</span>
        </span>
      )}
    </div>
  );
}

/** The header's live status, from the page's LiveEventsProvider. */
export function LiveStatus() {
  return <LiveStatusView degraded={useDegradedNotice()} />;
}
