/**
 * Announcements and their read receipts (WD01). Uncached (D-DC01).
 *
 * No audience filter on the announcement reads: targeting (audience/
 * department/team/audienceRoles) is enforced server-side by the CMS policy
 * `announcement-visibility`, which injects an id filter per caller. The old
 * client-side `$or` was redundant for department scoping and silently
 * missed team- and role-scoped posts entirely. These responses are
 * therefore per-user; so are the acknowledgement reads
 * (acknowledgement-visibility scopes them to the caller's own rows,
 * admin_role bypasses).
 */
import { ACK_REPORT_PAGE_SIZE, type ReportAnnouncement } from "@/lib/ack-report";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery, type StrapiQuery } from "@/lib/strapi/query";
import type { Acknowledgement, Announcement, UserLite } from "@/lib/types";

/** The card's author: username, e-mail (the sanitizer strips it for non-staff), name, title. */
export type AnnouncementAuthor = Pick<
  UserLite,
  "id" | "username" | "email" | "displayName" | "jobTitle"
>;

/** An announcement of a list (the cards): own fields and the field-limited author. */
export type AnnouncementListItem = Omit<Announcement, "author"> & {
  author?: AnnouncementAuthor | null;
};

const withAuthor = (query: StrapiQuery) =>
  query.populateFields("author", ["username", "email", "displayName", "jobTitle"]);

/**
 * The feed: pageSize=20 is a deliberate feed/render cap (issue #26).
 * Anyone who needs a COUNT must read `meta.pagination.total` (the count()
 * pattern from manage/analytics), never `data.length` — the total is
 * correct per user because the visibility policy filters the query before
 * the count. No department populate (WD05): no card renders it.
 */
export function listAnnouncements(): Promise<StrapiListResponse<AnnouncementListItem>> {
  return strapi<StrapiListResponse<AnnouncementListItem>>(
    withQuery(
      "/api/announcements",
      withAuthor(strapiQuery()).sortBy("pinned:desc,createdAt:desc").pageSize(20),
    ),
  );
}

/**
 * Mandatory-read announcements for the ack banner and the pinned "open
 * confirmations" section on /announcements — same visibility basis as
 * listAnnouncements, narrowed to requiresAck (a plain boolean attribute, so
 * the filter validates for every reading role). Author fields are
 * populated (same as the list) so cards rendered from this query are
 * complete; the banner just ignores them.
 *
 * A single request is bounded by its pageSize, so this walks every page —
 * dropping mandatory announcements past the first page would silently
 * undercount open confirmations in the banner and report (issue #14).
 * Secondary sort on id keeps the page walk stable when many rows share the
 * same createdAt. Hard cap: 50 pages x 100 = 5000 mandatory posts.
 */
export function listRequiringAck(): Promise<WalkResult<AnnouncementListItem>> {
  return walkAllPages<AnnouncementListItem>(
    (page) =>
      strapi<StrapiListResponse<AnnouncementListItem>>(
        withQuery(
          "/api/announcements",
          withAuthor(strapiQuery().filter("requiresAck", "$eq", true))
            .sort(["createdAt:desc", "id:desc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 50, label: "mandatory announcements" },
  );
}

/**
 * One page of the mandatory announcements with the fields their targeting
 * depends on, for the admin ack report (/manage/acknowledgements; v0.31:
 * the report pages, ACK_REPORT_PAGE_SIZE items, so every item stays
 * reachable and the page stays small). admin_role bypasses the visibility
 * policy, so the pages hold the whole set. The audienceRoles populate needs
 * `plugin::users-permissions.role.find`, which the CMS bootstrap grants to
 * admin_role for exactly this page. Secondary sort on id keeps the pages
 * stable when rows share a createdAt.
 */
export function ackReportAnnouncementsPage(
  page: number,
): Promise<StrapiListResponse<ReportAnnouncement>> {
  return strapi<StrapiListResponse<ReportAnnouncement>>(
    withQuery(
      "/api/announcements",
      strapiQuery()
        .filter("requiresAck", "$eq", true)
        .populateFields("department", ["name"])
        .populateFields("team", ["name"])
        .populateFields("audienceRoles", ["type", "name"])
        .sort(["createdAt:desc", "id:desc"])
        .page(page, ACK_REPORT_PAGE_SIZE),
    ),
  );
}

/**
 * One page of the caller's own acknowledgements of one target type, by id.
 * Filtered by the caller's user id explicitly: acknowledgement-visibility
 * lets admin_role read everyone's rows, which must not count as the
 * admin's own confirmations.
 */
export function myAcksPage(
  targetType: Acknowledgement["targetType"],
  userId: number,
  page: number,
  pageSize: number,
): Promise<StrapiListResponse<Acknowledgement>> {
  return strapi<StrapiListResponse<Acknowledgement>>(
    withQuery(
      "/api/acknowledgements",
      strapiQuery()
        .filter("targetType", "$eq", targetType)
        .filter(["user", "id"], "$eq", userId)
        .sortBy("id:asc")
        .page(page, pageSize),
    ),
  );
}

/** The cms's answer of POST /api/acknowledgements/report-index. */
export interface AckReportIndexResponse {
  data?: { acks?: Record<string, unknown> };
  meta?: { truncated?: boolean };
}

/**
 * Who confirmed which of up to 20 announcements or documents, across all
 * users (admin_role, the ack report; v0.31, #173): the cms reads the
 * receipts itself and answers documentId → user ids, `truncated` past its
 * budget of 2,000 receipts per item.
 */
export function ackReportIndex(
  targetType: Acknowledgement["targetType"],
  documentIds: readonly string[],
): Promise<AckReportIndexResponse> {
  return strapi<AckReportIndexResponse>("/api/acknowledgements/report-index", {
    method: "POST",
    body: JSON.stringify({ targetType, documentIds }),
  });
}
