"use client";

import { useCallback, useEffect, useState } from "react";
import { getNotifications, type NotificationFeed } from "@/lib/notification-actions";
import { applyLatest, createSeqGuard } from "@/lib/optimistic";
import { useLiveChannel } from "@/components/live/live-events-provider";
import { NotificationBell } from "./notification-bell";

/**
 * Notification bell data owner. Live SSE pings (delivered only to this
 * user's connections) trigger refetches; polling stays as the backstop —
 * 120s while the stream is healthy, today's 30s when degraded (issue #17
 * fallback contract). markRead in one tab pings the user's other tabs.
 * Each refetch brings the newest items AND the true unread total (WD10).
 */
const POLL_MS_DEGRADED = 30_000;
const POLL_MS_HEALTHY = 120_000;

export function LiveNotificationBell({ initial }: { initial: NotificationFeed }) {
  const [feed, setFeed] = useState(initial);

  // Overlapping refetches are applied newest-first by lastAppliedSeq
  // (lib/optimistic.ts, as in the comment section): an older snapshot never
  // overwrites a newer one (it would flip the badge back to unread right
  // after "Mark all read"), and the snapshot of a mark-read is no longer
  // dropped just because a live ping's refetch started meanwhile.
  const [guard] = useState(createSeqGuard);

  const refetch = useCallback(async () => {
    try {
      await applyLatest(guard, () => getNotifications(), setFeed);
    } catch {
      // Keep showing current state until next poll
    }
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
      onChanged={refetch}
    />
  );
}
