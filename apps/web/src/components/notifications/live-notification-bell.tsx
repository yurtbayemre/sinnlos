"use client";

import { useCallback, useEffect, useState } from "react";
import { getNotifications, type NotificationFeed } from "@/lib/notification-actions";
import { applyLatest, createSeqGuard } from "@/lib/optimistic";
import { useLiveChannel } from "@/components/live/live-events-provider";
import { NotificationBell, nextFeed } from "./notification-bell";

/**
 * Notification bell data owner. Live SSE pings (delivered only to this
 * user's connections) trigger refetches; polling stays as the backstop —
 * 120s while the stream is healthy, today's 30s when degraded (issue #17
 * fallback contract). markRead in one tab pings the user's other tabs.
 * Each refetch brings the newest items AND the true unread total (WD10).
 *
 * During an outage the bell keeps what it shows (batch-12 deferral): a
 * refetch the cms could not answer (getNotifications flags the feed
 * `unavailable`) or a call that never reached the web server keeps the
 * last feed and marks it, and the panel says so; the next good refetch
 * replaces it and clears the note.
 */
const POLL_MS_DEGRADED = 30_000;
const POLL_MS_HEALTHY = 120_000;

const UNAVAILABLE: NotificationFeed = { items: [], unreadTotal: 0, unavailable: true };

/**
 * getNotifications, with a rejected call (the web server unreachable) as an
 * unavailable feed. An expired session's redirect needs nothing here: the
 * router already navigates to sign-in when the action answers it.
 */
const loadFeed = () => getNotifications().catch(() => UNAVAILABLE);

export function LiveNotificationBell({ initial }: { initial: NotificationFeed }) {
  const [feed, setFeed] = useState(initial);

  // Overlapping refetches are applied newest-first by lastAppliedSeq
  // (lib/optimistic.ts, as in the comment section): an older snapshot never
  // overwrites a newer one (it would flip the badge back to unread right
  // after "Mark all read"), and the snapshot of a mark-read is no longer
  // dropped just because a live ping's refetch started meanwhile. The same
  // order holds for outages: a late failure never flags a newer good feed.
  const [guard] = useState(createSeqGuard);

  const refetch = useCallback(async () => {
    await applyLatest(guard, loadFeed, (next) => setFeed((previous) => nextFeed(previous, next)));
  }, [guard]);

  const healthy = useLiveChannel("notifications", refetch);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const id = setInterval(tick, healthy ? POLL_MS_HEALTHY : POLL_MS_DEGRADED);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refetch, healthy]);

  return (
    <NotificationBell
      notifications={feed.items}
      unreadTotal={feed.unreadTotal}
      unavailable={feed.unavailable === true}
      onChanged={refetch}
    />
  );
}
