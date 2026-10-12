import {
  countPage,
  reactionsPage,
  recentComments,
  searchSummary,
  unreadNotificationsPage,
  type CountedCollection,
  type SearchSummary,
} from "@/lib/api/analytics";
import { tryFetch } from "@/lib/safe-fetch";
import { displayNameOf } from "@/lib/utils";
import { countOfList, type Count } from "./count";

/**
 * /manage/analytics (WD03). admin_role bypasses the visibility policies,
 * so the totals are platform-wide. Every number is its own read: a failed
 * one is null ("–" on its tile) and raises the CMS-down banner, instead of
 * the 0 it used to show (and one failing activity read no longer zeroes
 * the other two). The user count streams separately
 * (lib/loaders/people-count.ts).
 */

/** The content overview's tiles, in display order. */
export type AnalyticsStat = CountedCollection | "reactions" | "unreadNotifications";

export const ANALYTICS_STATS: readonly AnalyticsStat[] = [
  "announcements",
  "events",
  "wiki-pages",
  "wiki-spaces",
  "documents",
  "polls",
  "comments",
  "reactions",
  "unreadNotifications",
];

/** A recent comment as the list shows it. */
export interface RecentComment {
  id: number;
  /** null: no name to show (the page says "unknown"). */
  authorName: string | null;
  body: string;
  createdAt: string | null;
}

export interface AnalyticsView {
  counts: Record<AnalyticsStat, Count>;
  /** The search telemetry of the last 30 days; null when its read failed. */
  search: (SearchSummary & { zeroRate: number }) | null;
  recentComments: RecentComment[];
  /** A read failed: the CMS-down banner. */
  failed: boolean;
  /** A count failed (a "–" tile): the banner explains the dash. */
  countsFailed: boolean;
}

/** Share of zero-result searches in whole percent (0 without searches). */
export function zeroResultRate(summary: Pick<SearchSummary, "total" | "zeroResultCount">): number {
  return summary.total > 0 ? Math.round((summary.zeroResultCount / summary.total) * 100) : 0;
}

export async function loadAnalytics(): Promise<AnalyticsView> {
  const collections: CountedCollection[] = [
    "announcements",
    "events",
    "wiki-pages",
    "wiki-spaces",
    "documents",
    "polls",
    "comments",
  ];
  const [collectionCounts, reactions, unread, comments, search] = await Promise.all([
    Promise.all(collections.map((c) => tryFetch(() => countPage(c), "analytics"))),
    tryFetch(() => reactionsPage(), "analytics"),
    tryFetch(() => unreadNotificationsPage(), "analytics"),
    tryFetch(() => recentComments(), "analytics"),
    tryFetch(() => searchSummary(), "analytics"),
  ]);

  const counts = Object.fromEntries(
    collections.map((c, i) => [c, countOfList(collectionCounts[i]!)]),
  ) as Record<CountedCollection, Count>;

  const allCounts: Record<AnalyticsStat, Count> = {
    ...counts,
    reactions: countOfList(reactions),
    unreadNotifications: countOfList(unread),
  };
  const countsFailed = Object.values(allCounts).some((c) => c.value === null);

  return {
    counts: allCounts,
    search: search.data ? { ...search.data, zeroRate: zeroResultRate(search.data) } : null,
    recentComments: (comments.data?.data ?? []).map((c) => ({
      id: c.id,
      authorName: displayNameOf(c.author, null),
      body: c.body,
      createdAt: c.createdAt ?? null,
    })),
    failed: countsFailed || comments.failed || search.failed,
    countsFailed,
  };
}
