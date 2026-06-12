"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, Megaphone, MessageCircle, Calendar, Award } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  markNotificationsRead,
  markAllNotificationsRead,
} from "@/lib/notification-actions";
import type { Notification } from "@/lib/types";

function relative(dateStr: string | undefined) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const typeIcon: Record<string, typeof Bell> = {
  announcement: Megaphone,
  comment: MessageCircle,
  event: Calendar,
  kudos: Award,
};

export function NotificationBell({
  notifications,
}: {
  notifications: Notification[];
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleOpen = () => {
    setOpen(!open);
  };

  const handleClick = (notif: Notification) => {
    if (!notif.readAt) {
      startTransition(async () => {
        await markNotificationsRead([notif.id]);
      });
    }
    setOpen(false);
    if (notif.link) router.push(notif.link);
  };

  const handleMarkAll = () => {
    startTransition(async () => {
      await markAllNotificationsRead();
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border bg-background transition hover:bg-muted"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        // Phones: full-width panel pinned under the topbar (right-0 with a
        // fixed width would run off the left edge). sm+: anchored dropdown.
        // The topbar's backdrop-filter makes it the containing block for
        // `fixed`, so top-16 lands exactly at the header's bottom edge.
        <div className="fixed inset-x-3 top-16 z-50 animate-scale-in overflow-hidden rounded-xl border bg-background shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                disabled={isPending}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => {
                const Icon = typeIcon[n.type] ?? Bell;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleClick(n)}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-muted",
                      !n.readAt && "bg-primary/[0.04]",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        !n.readAt
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "text-sm",
                          !n.readAt ? "font-medium" : "text-muted-foreground",
                        )}
                      >
                        {n.title}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {relative(n.createdAt)}
                      </div>
                    </div>
                    {!n.readAt && (
                      <div className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
