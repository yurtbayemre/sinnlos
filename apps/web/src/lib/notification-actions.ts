"use server";

import { unstable_rethrow } from "next/navigation";
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
 * bell must show the caller's own notifications only. The unread count is
 * one extra request that returns a single row (pageSize 1). No session user
 * = the empty feed without a request; any cms failure = the empty feed (the
 * bell polls on), EXCEPT strapi()'s 401 sign-in redirect, which propagates
 * (otherwise the bell would poll an expired session forever).
 */
export async function getNotifications(): Promise<NotificationFeed> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return EMPTY_FEED;
  try {
    const [list, unread] = await Promise.all([
      strapi<StrapiListResponse<Notification>>(
        `/api/notifications?filters[recipient][id][$eq]=${userId}&populate[actor]=true&sort=createdAt:desc&pagination[pageSize]=20`,
      ),
      strapi<StrapiListResponse<Notification>>(
        `/api/notifications?filters[recipient][id][$eq]=${userId}&filters[readAt][$null]=true&fields[0]=id&pagination[pageSize]=1`,
      ),
    ]);
    const items = Array.isArray(list?.data) ? list.data : [];
    const total = unread?.meta?.pagination?.total;
    return {
      items,
      // A response without a total (DEMO_MODE fixtures, a proxy mangling
      // the body) falls back to the unread among the loaded items.
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

export async function markNotificationsRead(ids: number[]) {
  await strapi("/api/notifications/mark-read", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function markAllNotificationsRead() {
  await strapi("/api/notifications/mark-all-read", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
