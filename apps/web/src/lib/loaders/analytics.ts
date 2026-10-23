import {
  countPage,
  reactionsPage,
  recentComments,
  searchSummary,
  unreadNotificationCount,
  type CountedCollection,
  type SearchSummary,
} from "@/lib/api/analytics";
import type { SwitchName } from "@sinnlos/domain";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";
import { switchedOff } from "@/lib/switches";
import { displayNameOf } from "@/lib/utils";
import { countOfList, FAILED_COUNT, type Count } from "./count";

/**
 * /manage/analytics (WD03). admin_role bypasses the visibility policies,
 * so the totals are platform-wide. Every number is its own read: a failed
 * one is null ("–" on its tile) and raises the CMS-down banner, instead of
 * the 0 it used to show (and one failing activity read no longer zeroes
 * the other two). The user count streams separately
 * (lib/loaders/people-count.ts). The unread total is the cms's aggregate
 * (v0.28: no named notification reads for admins any more). FEATURES_OFF
 * drops the tiles of an off module (events, polls) and, with search
 * logging off, the search section: none of them is read then.
 */

/** The content overview's tiles, in display order. */
export type AnalyticsStat = CountedCollection | "reactions" | "unreadNotifications";

/** The collections counted by countPage(), in display order (and request order). */
const COUNTED_COLLECTIONS: readonly CountedCollection[] = [
  "announcements",
  "events",
  "wiki-pages",
  "wiki-spaces",
  "documents",
  "polls",
  "comments",
];

export const ANALYTICS_STATS: readonly AnalyticsStat[] = [
  ...COUNTED_COLLECTIONS,
  "reactions",
  "unreadNotifications",
];

/** The module of each counted collection that belongs to one. */
const COLLECTION_MODULE: Readonly<Partial<Record<CountedCollection, SwitchName>>> = {
  events: "events",
  polls: "polls",
};

/** The tiles shown with `off` switched off, in display order. */
export function analyticsStats(off: ReadonlySet<SwitchName>): AnalyticsStat[] {
  return ANALYTICS_STATS.filter((stat) => {
    const module = COLLECTION_MODULE[stat as CountedCollection];
    return module === undefined || !off.has(module);
  });
}

/** A recent comment as the list shows it. */
export interface RecentComment {
  id: number;
  /** null: no name to show (the page says "unknown"). */
  authorName: string | null;
  body: string;
  createdAt: string | null;
}

export interface AnalyticsView {
  /** The tiles to show (analyticsStats). */
  stats: AnalyticsStat[];
  counts: Record<AnalyticsStat, Count>;
  /** The search telemetry of the last 30 days; null when its read failed or search logging is off. */
  search: (SearchSummary & { zeroRate: number }) | null;
  recentComments: RecentComment[];
  /** A read failed: the CMS-down banner. */
  failed: boolean;
  /** A count failed (a "–" tile): the banner explains the dash. */
  countsFailed: boolean;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * A search summary as the page renders it; anything else (an older cms, a
 * proxy error page, a fixture without the route) counts as a failed read
 * instead of crashing the page on `topTerms.length`.
 */
export function isSearchSummary(value: unknown): value is SearchSummary {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isCount(v.windowDays) &&
    isCount(v.total) &&
    isCount(v.zeroResultCount) &&
    Array.isArray(v.topTerms) &&
    Array.isArray(v.topZeroTerms)
  );
}

/** Share of zero-result searches in whole percent (0 without searches). */
export function zeroResultRate(summary: Pick<SearchSummary, "total" | "zeroResultCount">): number {
  return summary.total > 0 ? Math.round((summary.zeroResultCount / summary.total) * 100) : 0;
}

export async function loadAnalytics(): Promise<AnalyticsView> {
  const off = switchedOff();
  const stats = analyticsStats(off);
  const searchOn = !off.has("search-logging");
  const shown = (stat: AnalyticsStat) => stats.includes(stat);
  const [collectionCounts, reactions, unread, comments, search] = await Promise.all([
    Promise.all(
      COUNTED_COLLECTIONS.map((c) =>
        shown(c) ? tryFetch(() => countPage(c), "analytics") : SKIPPED_READ,
      ),
    ),
    tryFetch(() => reactionsPage(), "analytics"),
    tryFetch(() => unreadNotificationCount(), "analytics"),
    tryFetch(() => recentComments(), "analytics"),
    searchOn ? tryFetch(() => searchSummary(), "analytics") : SKIPPED_READ,
  ]);

  const counts = Object.fromEntries(
    COUNTED_COLLECTIONS.map((c, i) => [c, countOfList(collectionCounts[i]!)]),
  ) as Record<CountedCollection, Count>;

  const unreadCount = unread.data?.count;
  const allCounts: Record<AnalyticsStat, Count> = {
    ...counts,
    reactions: countOfList(reactions),
    unreadNotifications:
      typeof unreadCount === "number" && Number.isFinite(unreadCount) && unreadCount >= 0
        ? { value: unreadCount, truncated: false }
        : FAILED_COUNT,
  };
  const countsFailed = stats.some((stat) => allCounts[stat].value === null);
  const summary = isSearchSummary(search.data) ? search.data : null;

  return {
    stats,
    counts: allCounts,
    search: summary ? { ...summary, zeroRate: zeroResultRate(summary) } : null,
    recentComments: (comments.data?.data ?? []).map((c) => ({
      id: c.id,
      authorName: displayNameOf(c.author, null),
      body: c.body,
      createdAt: c.createdAt ?? null,
    })),
    failed: countsFailed || comments.failed || (searchOn && summary === null),
    countsFailed,
  };
}
