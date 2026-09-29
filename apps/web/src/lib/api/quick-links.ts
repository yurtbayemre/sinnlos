/**
 * Dashboard quick links (WD01). Per-user: the quick-link-visibility policy
 * filters by the caller's department. Deliberately NO populate of
 * `departments`: the policy scopes server-side, and populating the relation
 * would 400 for roles without department.find (guest). Uncached (D-DC01).
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { QuickLink } from "@/lib/types";

/**
 * Walks every page (issue #26): the list is curated and stays well below
 * 100 links, so this still costs exactly one request (the walk stops at
 * pageCount=1) — but if it ever grows past 100 nothing is silently lost.
 * Secondary sort on id keeps the walk stable. Hard cap: 5 x 100 = 500.
 */
export function listQuickLinks(): Promise<WalkResult<QuickLink>> {
  return walkAllPages<QuickLink>(
    (page) =>
      strapi<StrapiListResponse<QuickLink>>(
        withQuery(
          "/api/quick-links",
          strapiQuery().sort(["order:asc", "label:asc", "id:asc"]).page(page, 100),
        ),
      ),
    { maxPages: 5, label: "quick links" },
  );
}
