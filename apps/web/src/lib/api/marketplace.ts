/**
 * Marketplace ads (WD01). Uncached (D-DC01): after create/renew the author
 * sees the change immediately (the actions call refresh()). The author
 * populate is field-limited; e-mail is needed for the mailto contact button
 * on the detail page (company-internal address).
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery, type StrapiQuery } from "@/lib/strapi/query";
import type { Classified, UserLite } from "@/lib/types";

/** An ad with its images and the field-limited author. */
export type ClassifiedView = Omit<Classified, "author"> & {
  author?: Pick<UserLite, "id" | "displayName" | "email" | "jobTitle"> | null;
};

const withAuthor = (query: StrapiQuery) =>
  query.populate("images").populateFields("author", ["displayName", "email", "jobTitle"]);

/**
 * Both list reads walk every page — a single request is bounded by its
 * pageSize, so a busy board would silently lose every ad past the first
 * 100 (issue #14). Secondary sort on id keeps the walk stable when many ads
 * share a createdAt. Hard cap: 50 pages x 100 = 5000 ads.
 * `today` is the calendar date 'YYYY-MM-DD' in APP_TIME_ZONE
 * (classified-shared.classifiedToday): expiresAt is a date column, and an
 * ad expiring today stays listed for the rest of that day.
 */
export function listClassifieds(
  today: string,
  category?: string,
): Promise<WalkResult<ClassifiedView>> {
  return walkAllPages<ClassifiedView>(
    (page) => {
      const query = strapiQuery().filter("expiresAt", "$gte", today);
      if (category) query.filter("category", "$eq", category);
      return strapi<StrapiListResponse<ClassifiedView>>(
        withQuery(
          "/api/classifieds",
          withAuthor(query).sort(["createdAt:desc", "id:desc"]).page(page, 100),
        ),
      );
    },
    { maxPages: 50, label: "marketplace ads" },
  );
}

/**
 * Own ads including expired ones (renew UI). The author filter is a
 * user-relation traversal — fine for every posting role (all hold
 * user.find), and guests never reach this query.
 */
export function myClassifieds(userId: number): Promise<WalkResult<Classified>> {
  return walkAllPages<Classified>(
    (page) =>
      strapi<StrapiListResponse<Classified>>(
        withQuery(
          "/api/classifieds",
          strapiQuery()
            .filter(["author", "id"], "$eq", userId)
            .populate("images")
            .sort(["createdAt:desc", "id:desc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 50, label: "own marketplace ads" },
  );
}

/** One ad by its row id (the detail and edit pages check the id first, WD07). */
export function classifiedById(id: string): Promise<StrapiListResponse<ClassifiedView>> {
  return strapi<StrapiListResponse<ClassifiedView>>(
    withQuery("/api/classifieds", withAuthor(strapiQuery().filter("id", "$eq", id))),
  );
}
