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
import type { ReportAck, ReportAnnouncement } from "@/lib/ack-report";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery, type StrapiQuery } from "@/lib/strapi/query";
import type { Acknowledgement, Announcement, UserLite } from "@/lib/types";

/** The card's author: username, e-mail (the sanitizer strips it for non-staff), name, title. */
export type AnnouncementAuthor = Pick<
  UserLite,
  "id" | "username" | "email" | "displayName" | "jobTitle"
>;

/** An announcement card: own fields and the field-limited author. */
export type AnnouncementCard = Omit<Announcement, "author"> & {
  author?: AnnouncementAuthor | null;
};

/** An acknowledgement as the report index reads it: target and user id only. */
export type AckIndexRow = ReportAck & { id: number };

const withAuthor = (query: StrapiQuery) =>
  query.populateFields("author", ["username", "email", "displayName", "jobTitle"]);

/**
 * The feed: pageSize=20 is a deliberate feed/render cap (issue #26).
 * Anyone who needs a COUNT must read `meta.pagination.total` (the count()
 * pattern from manage/analytics), never `data.length` — the total is
 * correct per user because the visibility policy filters the query before
 * the count. No department populate (WD05): no card renders it.
 */
export function listAnnouncements(): Promise<StrapiListResponse<AnnouncementCard>> {
  return strapi<StrapiListResponse<AnnouncementCard>>(
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
export function listRequiringAck(): Promise<WalkResult<AnnouncementCard>> {
  return walkAllPages<AnnouncementCard>(
    (page) =>
      strapi<StrapiListResponse<AnnouncementCard>>(
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
 * Every mandatory announcement with the fields its targeting depends on,
 * for the admin ack report (/manage/acknowledgements). admin_role bypasses
 * the visibility policy, so this is the whole set. The audienceRoles
 * populate needs `plugin::users-permissions.role.find`, which the CMS
 * bootstrap grants to admin_role for exactly this page. Full page walk,
 * not a single pageSize=100 request: a mandatory announcement dropped past
 * the first page would silently vanish from the report and never be chased
 * for confirmation (#14). Secondary sort on id keeps the walk stable when
 * rows share a createdAt.
 */
export function listAckReportAnnouncements(): Promise<WalkResult<ReportAnnouncement>> {
  return walkAllPages<ReportAnnouncement>(
    (page) =>
      strapi<StrapiListResponse<ReportAnnouncement>>(
        withQuery(
          "/api/announcements",
          strapiQuery()
            .filter("requiresAck", "$eq", true)
            .populateFields("department", ["name"])
            .populateFields("team", ["name"])
            .populateFields("audienceRoles", ["type", "name"])
            .sort(["createdAt:desc", "id:desc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 50, label: "ack-report announcements" },
  );
}

/** One page of the caller's own announcement acknowledgements, by id. */
export function myAnnouncementAcksPage(
  page: number,
  pageSize: number,
): Promise<StrapiListResponse<Acknowledgement>> {
  return strapi<StrapiListResponse<Acknowledgement>>(
    withQuery(
      "/api/acknowledgements",
      strapiQuery()
        .filter("targetType", "$eq", "announcement")
        .sortBy("id:asc")
        .page(page, pageSize),
    ),
  );
}

/**
 * One page of the acknowledgements of the given announcements across all
 * users (admin_role, the ack report, FX32): only the target and the user's
 * id, sorted by id so the pages of a walk stay stable.
 */
export function announcementAcksPage(
  documentIds: readonly string[],
  page: number,
  pageSize: number,
): Promise<StrapiListResponse<AckIndexRow>> {
  return strapi<StrapiListResponse<AckIndexRow>>(
    withQuery(
      "/api/acknowledgements",
      strapiQuery()
        .filter("targetType", "$eq", "announcement")
        .filterIn("targetDocumentId", documentIds)
        .fields(["targetDocumentId"])
        .populateFields("user", ["id"])
        .sort(["id:asc"])
        .page(page, pageSize),
    ),
  );
}
