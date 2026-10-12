"use client";

import { useId, useState, useTransition } from "react";
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
import {
  markNotificationsRead,
  markAllNotificationsRead,
  type NotificationFeed,
} from "@/lib/notification-actions";
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
 * The feed the bell shows after a refetch (batch-12 deferral): an
 * unavailable answer (the cms unreachable, or the call itself failed) keeps
 * the last feed and flags it, so the bell no longer empties itself — badge
 * and list included — during an outage; any other answer replaces it.
 */
export function nextFeed(previous: NotificationFeed, next: NotificationFeed): NotificationFeed {
  if (!next.unavailable) return next;
  return previous.unavailable ? previous : { ...previous, unavailable: true };
}

/**
 * The bell's refetch: loads a feed and hands `update` the step to apply
 * (nextFeed), in order. Only a good answer moves the order on
 * (`lastGood`): any answer to a request older than the last good one is
 * dropped, so an older snapshot never overwrites a newer one (it would
 * flip the badge back to unread right after "Mark all read") and a late
 * failure never flags a newer good feed. A failure itself stays out of
 * the order: it flags the shown feed but never blocks an older good
 * answer still in flight (after a navigation, Next lets the refetches of
 * the old page run on), which would otherwise keep a stale, flagged feed
 * until the next poll. `load` must not reject: the caller turns a failed
 * call into an unavailable feed.
 */
export function createFeedRefetch(
  load: () => Promise<NotificationFeed>,
  update: (step: (previous: NotificationFeed) => NotificationFeed) => void,
): () => Promise<void> {
  let lastIssued = 0;
  let lastGood = 0;
  return async () => {
    const seq = ++lastIssued;
    const next = await load();
    if (seq <= lastGood) return;
    if (!next.unavailable) lastGood = seq;
    update((previous) => nextFeed(previous, next));
  };
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
  unavailable = false,
  onChanged,
}: {
  /** The newest notifications (the panel lists these). */
  notifications: Notification[];
  /**
   * ALL unread notifications of the caller (getNotifications, WD10) — the
   * badge used to count only the unread among the 20 loaded ones.
   */
  unreadTotal: number;
  /**
   * The last refetch could not reach the cms: the list and the badge are
   * the last known ones, and the panel says so (actionErrors.unavailable).
   */
  unavailable?: boolean;
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
  const unavailableNoteId = useId();

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
      {unavailable && (
        // The trigger's description: a screen reader hears it on the bell,
        // before the panel opens.
        <span id={unavailableNoteId} hidden>
          {tErrors("unavailable")}
        </span>
      )}
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${t("title")}${unreadCount > 0 ? ` (${unreadCount} ${t("unread")})` : ""}`}
          aria-describedby={unavailable ? unavailableNoteId : undefined}
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
          {unavailable && (
            <p className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
              {tErrors("unavailable")}
            </p>
          )}
          {failed && (
            <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
              {isSharedErrorCode(failed) ? tErrors(failed) : t("markReadFailed")}
            </p>
          )}
          <div className="max-h-80 overflow-y-auto">
            {/* Unavailable before any feed arrived (the cms was down when the
                page loaded): the note above says so, and "no notifications
                yet" would claim what nobody knows. */}
            {notifications.length === 0 && !unavailable ? (
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
