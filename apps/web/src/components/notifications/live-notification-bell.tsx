"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getNotifications } from "@/lib/notification-actions";
import { useLiveChannel } from "@/components/live/live-events-provider";
import { NotificationBell } from "./notification-bell";
import type { Notification } from "@/lib/types";

/**
 * Notification bell data owner. Live SSE pings (delivered only to this
 * user's connections) trigger refetches; polling stays as the backstop —
 * 120s while the stream is healthy, today's 30s when degraded (issue #17
 * fallback contract). markRead in one tab pings the user's other tabs.
 */
const POLL_MS_DEGRADED = 30_000;
const POLL_MS_HEALTHY = 120_000;

export function LiveNotificationBell({ initial }: { initial: Notification[] }) {
  const [notifications, setNotifications] = useState(initial);

  // Monotonic request counter — an out-of-order snapshot would flip the
  // badge back to unread right after markAllRead.
  const seqRef = useRef(0);

  const refetch = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const fresh = await getNotifications();
      if (seq === seqRef.current) setNotifications(fresh);
    } catch {
      // Keep showing current state until next poll
    }
  }, []);

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

  return <NotificationBell notifications={notifications} onChanged={refetch} />;
}
