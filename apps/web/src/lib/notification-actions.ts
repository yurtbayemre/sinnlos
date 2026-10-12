"use server";

import { unstable_rethrow } from "next/navigation";
import { runCmsAction, type ActionResult } from "@/lib/action-result";
import { getSession } from "@/lib/session";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import type { Notification } from "@/lib/types";

/** What the bell shows: the newest notifications and the true unread count. */
export interface NotificationFeed {
  /** The caller's newest 20. */
  items: Notification[];
  /**
   * ALL of the caller's unread notifications (WD10): meta.pagination.total
   * of a readAt=null query, not the unread among the 20 loaded ones.
   */
  unreadTotal: number;
}

const EMPTY_FEED: NotificationFeed = { items: [], unreadTotal: 0 };

/**
 * The bell's data, for the topbar's first render and every refetch. The
 * recipient filter is explicit: admin_role bypasses the
 * notification-visibility policy (analytics counts platform-wide), and the
 * bell must show the caller's own notifications only. No relation is
 * populated (WD05): no component renders the actor, and the feed is
 * serialised into every page's payload as the bell's props. The unread
 * count is one extra request that returns a single row (pageSize 1). No
 * session user = the empty feed without a request. A failed list = the
 * empty feed (the bell polls on); a failed count alone keeps the loaded
 * list and counts the unread among it. strapi()'s 401 sign-in redirect from
 * EITHER request propagates (otherwise the bell would poll an expired
 * session forever).
 */
export async function getNotifications(): Promise<NotificationFeed> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return EMPTY_FEED;
  try {
    const [list, unread] = await Promise.allSettled([
      strapi<StrapiListResponse<Notification>>(
        `/api/notifications?filters[recipient][id][$eq]=${userId}&sort=createdAt:desc&pagination[pageSize]=20`,
      ),
      strapi<StrapiListResponse<Notification>>(
        `/api/notifications?filters[recipient][id][$eq]=${userId}&filters[readAt][$null]=true&fields[0]=id&pagination[pageSize]=1`,
      ),
    ]);
    // The redirect of either request wins; a failed count alone must not
    // cost the loaded list, a failed list is the empty feed (catch below).
    if (unread.status === "rejected") unstable_rethrow(unread.reason);
    if (list.status === "rejected") throw list.reason;
    const items = Array.isArray(list.value?.data) ? list.value.data : [];
    const total = unread.status === "fulfilled" ? unread.value?.meta?.pagination?.total : undefined;
    return {
      items,
      // No usable total (the count failed, DEMO_MODE fixtures, a proxy
      // mangling the body): the unread among the loaded items.
      unreadTotal:
        typeof total === "number" && Number.isInteger(total) && total >= 0
          ? total
          : items.filter((n) => !n.readAt).length,
    };
  } catch (e) {
    // strapi() issues redirect() (NEXT_REDIRECT) on an expired session —
    // let that control-flow error escape instead of swallowing it and
    // polling the bell forever with an empty list.
    unstable_rethrow(e);
    return EMPTY_FEED;
  }
}

/**
 * Marks the caller's notifications `ids` read. Answers an ActionResult
 * (AC01); the cms validates the ids (a 400 is "invalid") and only ever
 * touches the caller's own rows. No refresh(): the bell refetches itself.
 */
export async function markNotificationsRead(ids: number[]): Promise<ActionResult> {
  return runCmsAction(
    () =>
      strapi("/api/notifications/mark-read", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    { label: "[notifications] mark read" },
  );
}

/** Marks every notification of the caller read (ActionResult, AC01). */
export async function markAllNotificationsRead(): Promise<ActionResult> {
  return runCmsAction(
    () =>
      strapi("/api/notifications/mark-all-read", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    { label: "[notifications] mark all read" },
  );
}
