"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
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

/**
 * The topbar bell. The panel is a Radix DropdownMenu (UI02, the primitive
 * of SelectMenu): portaled out of the blurred topbar, arrow keys and
 * typeahead over the notifications, Escape and outside click close it, and
 * focus returns to the bell. Every notification and "Mark all read" is a
 * menu item; "Mark all read" keeps the panel open (its error shows there).
 */
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
  const router = useRouter();

  // Never below what the panel itself shows as unread (a notification
  // that arrived between the list and the count request).
  const unreadCount = Math.max(unreadTotal, notifications.filter((n) => !n.readAt).length);

  // A failed mark-read keeps the page (FX28): the bell lives in the layout,
  // so an uncaught rejection here replaced the whole app with the global
  // error page. The error shows in the open panel until the next attempt.
  const [failed, setFailed] = useState<CommonCode | null>(null);

  // Opening the panel clears an old error: a click-through closes the panel
  // before its mark-read settles, and the bell stays mounted across pages,
  // so the error would describe an earlier click. The notification that
  // failed stays unread, which is the lasting signal.
  const handleOpenChange = (next: boolean) => {
    if (next) setFailed(null);
    setOpen(next);
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

  // Selecting an item closes the menu (Radix calls onOpenChange); the
  // explicit close keeps that true for any caller of the handler.
  const handleClick = (notif: Notification) => {
    if (!notif.readAt) runAction(() => markNotificationsRead([notif.id]));
    setOpen(false);
    // Server-authored notification links ("/announcements", …) — data-
    // driven, so typedRoutes needs the cast.
    if (notif.link) router.push(notif.link as Route);
  };

  // preventDefault keeps the menu open, so the result shows in the panel.
  const handleMarkAll = (event: Event) => {
    event.preventDefault();
    runAction(() => markAllNotificationsRead());
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${t("title")}${unreadCount > 0 ? ` (${unreadCount} ${t("unread")})` : ""}`}
        >
          <Bell aria-hidden="true" className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {unreadBadge(unreadCount)}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        {/* Phones: nearly the full width (the collision padding keeps 12 px
            to each edge); sm+: 24rem, aligned to the bell's right edge. */}
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[calc(100vw-1.5rem)] animate-scale-in overflow-hidden rounded-xl border bg-background shadow-lg sm:w-96"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <DropdownMenu.Label className="text-sm font-semibold">{t("title")}</DropdownMenu.Label>
            {unreadCount > 0 && (
              <DropdownMenu.Item
                onSelect={handleMarkAll}
                disabled={isPending}
                className="cursor-pointer rounded-md text-xs text-primary outline-none hover:underline data-[disabled]:opacity-50 data-[highlighted]:underline data-[highlighted]:ring-2 data-[highlighted]:ring-ring data-[highlighted]:ring-offset-2 data-[highlighted]:ring-offset-background"
              >
                {t("markAllRead")}
              </DropdownMenu.Item>
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
                  <DropdownMenu.Item
                    key={n.id}
                    onSelect={() => handleClick(n)}
                    className={cn(
                      "flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted data-[highlighted]:bg-muted",
                      !n.readAt && "bg-primary/[0.04]",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        !n.readAt ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4" />
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
                  </DropdownMenu.Item>
                );
              })
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
