"use client";

import { useCallback, useEffect, useState } from "react";
import { getNotifications } from "@/lib/notification-actions";
import { NotificationBell } from "./notification-bell";
import type { Notification } from "@/lib/types";

const POLL_MS = 30_000;

export function LiveNotificationBell({
  initial,
}: {
  initial: Notification[];
}) {
  const [notifications, setNotifications] = useState(initial);

  const refetch = useCallback(async () => {
    try {
      setNotifications(await getNotifications());
    } catch {
      // Keep showing current state until next poll
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refetch]);

  return <NotificationBell notifications={notifications} onChanged={refetch} />;
}
