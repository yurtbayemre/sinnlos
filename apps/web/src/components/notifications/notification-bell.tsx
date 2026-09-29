"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Bell, Megaphone, MessageCircle, Calendar, Award } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isSharedErrorCode,
  startCmsAction,
  type ActionResult,
  type CommonCode,
} from "@/lib/action-result";
import { markNotificationsRead, markAllNotificationsRead } from "@/lib/notification-actions";
import { DEFAULT_APP_TIME_ZONE } from "@/lib/plain-date";
import { relativeTime } from "@/lib/relative-time";
import type { Notification } from "@/lib/types";
import { useLocale, useTimeZone, useTranslations } from "next-intl";

const typeIcon: Record<string, typeof Bell> = {
  announcement: Megaphone,
  comment: MessageCircle,
  event: Calendar,
  kudos: Award,
};

/** The badge text: the count, capped at "99+". */
export function unreadBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function NotificationBell({
  notifications,
  unreadTotal,
  onChanged,
}: {
  /** The newest notifications (the panel lists these). */
  notifications: Notification[];
  /**
   * ALL unread notifications of the caller (getNotifications, WD10) — the
   * badge used to count only the unread among the 20 loaded ones.
   */
  unreadTotal: number;
  onChanged?: () => void | Promise<void>;
}) {
  const t = useTranslations("notifications");
  const tRel = useTranslations("relativeTime");
  const tErrors = useTranslations("actionErrors");
  // The app locale and APP_TIME_ZONE from the provider (i18n/request.ts;
  // the root layout always sets the zone, the fallback is its default).
  const locale = useLocale();
  const timeZone = useTimeZone() ?? DEFAULT_APP_TIME_ZONE;
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Never below what the panel itself shows as unread (a notification
  // that arrived between the list and the count request).
  const unreadCount = Math.max(unreadTotal, notifications.filter((n) => !n.readAt).length);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // A failed mark-read keeps the page (FX28): the bell lives in the layout,
  // so an uncaught rejection here replaced the whole app with the global
  // error page. The error shows in the open panel until the next attempt.
  const [failed, setFailed] = useState<CommonCode | null>(null);

  // Opening the panel clears an old error: a click-through closes the panel
  // before its mark-read settles, and the bell stays mounted across pages,
  // so the error would describe an earlier click. The notification that
  // failed stays unread, which is the lasting signal.
  const handleOpen = () => {
    if (!open) setFailed(null);
    setOpen(!open);
  };

  // A refused or failed mark-read answers a code (AC01); an expired
  // session still redirects to sign-in (the helper rethrows it).
  const runAction = (action: () => Promise<ActionResult>) => {
    setFailed(null);
    startCmsAction(startTransition, {
      action,
      onSuccess: () => onChanged?.(),
      onFailure: setFailed,
    });
  };

  const handleClick = (notif: Notification) => {
    if (!notif.readAt) runAction(() => markNotificationsRead([notif.id]));
    setOpen(false);
    // Server-authored notification links ("/announcements", …) — data-
    // driven, so typedRoutes needs the cast.
    if (notif.link) router.push(notif.link as Route);
  };

  const handleMarkAll = () => runAction(() => markAllNotificationsRead());

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${t("title")}${unreadCount > 0 ? ` (${unreadCount} ${t("unread")})` : ""}`}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {unreadBadge(unreadCount)}
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
            <span className="text-sm font-semibold">{t("title")}</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                disabled={isPending}
                className="rounded-md text-xs text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
              >
                {t("markAllRead")}
              </button>
            )}
          </div>
          {failed && (
            <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
              {isSharedErrorCode(failed) ? tErrors(failed) : t("markReadFailed")}
            </p>
          )}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t("noNotificationsYet")}
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
                      "flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      !n.readAt && "bg-primary/[0.04]",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        !n.readAt ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
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
                        {relativeTime(n.createdAt, tRel, {
                          granularity: "minute",
                          locale,
                          timeZone,
                        })}
                      </div>
                    </div>
                    {!n.readAt && <div className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />}
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
