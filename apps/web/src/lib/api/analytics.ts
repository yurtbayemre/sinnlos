/**
 * The admin analytics reads (/manage/analytics, WD01). admin_role bypasses
 * the visibility policies, so the totals are platform-wide. Uncached
 * (D-DC01).
 */
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Comment } from "@/lib/types";

/** The collections the content overview counts. */
export type CountedCollection =
  "announcements" | "events" | "wiki-pages" | "wiki-spaces" | "documents" | "polls" | "comments";

/** Aggregated search telemetry (issue #19). */
export type SearchSummary = {
  windowDays: number;
  total: number;
  zeroResultCount: number;
  topTerms: { term: string; count: number; avgResults: number }[];
  topZeroTerms: { term: string; count: number }[];
};

/**
 * One row of `collection`, for its `meta.pagination.total`. The empty pair
 * after `?` is the page's historic URL, kept byte-identical by the WD01
 * move (strapi-urls.test.ts); Strapi's query parser skips it.
 */
export function countPage(collection: CountedCollection): Promise<StrapiListResponse<unknown>> {
  return strapi<StrapiListResponse<unknown>>(
    `/api/${collection}?&${strapiQuery().pageSize(1).toString()}`,
  );
}

/** The five newest comments with their author. */
export function recentComments(): Promise<StrapiListResponse<Comment>> {
  return strapi<StrapiListResponse<Comment>>(
    withQuery(
      "/api/comments",
      strapiQuery().sortBy("createdAt:desc").pageSize(5).populate("author"),
    ),
  );
}

/** One reaction, for the total. */
export function reactionsPage(): Promise<StrapiListResponse<unknown>> {
  return strapi<StrapiListResponse<unknown>>(
    withQuery("/api/reactions", strapiQuery().sortBy("createdAt:desc").pageSize(1)),
  );
}

/**
 * The platform-wide unread total (v0.28): a number from the admin-only
 * aggregate route. Notification reads are own rows only for every role
 * since v0.28, so the old one-row list would count the admin's own.
 */
export function unreadNotificationCount(): Promise<{ count: number }> {
  return strapi<{ count: number }>("/api/notifications/unread-count");
}

/** The search telemetry of the last 30 days (admin-only custom route). */
export function searchSummary(): Promise<SearchSummary> {
  return strapi<SearchSummary>(
    withQuery("/api/search-logs/summary", strapiQuery().literal("days", 30)),
  );
}
