import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { walkAllPages } from "@/lib/paginate";
import type { Acknowledgement } from "@/lib/types";

/**
 * Server-side helpers around /api/acknowledgements.
 *
 * The acknowledgement-visibility policy scopes reads to the caller's own
 * rows (admin_role bypasses), so every fetch here MUST use noCache —
 * the Next.js fetch cache keys by URL only and would leak one user's
 * acknowledgement state to everyone else.
 *
 * A single request is bounded by its `pageSize`, so both helpers walk the
 * pagination until exhausted and report back whether the walk actually
 * finished — a truncated ack list makes the compliance report undercount
 * confirmations, so it must NOT be mistaken for a complete one (issue #14).
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** All matching announcement acks, plus whether the page walk finished. */
export interface AnnouncementAcksResult {
  acks: Acknowledgement[];
  /** true when the walk stopped at MAX_PAGES with pages left over. */
  truncated: boolean;
}

function fetchAllAnnouncementAcksPaged(params: string): Promise<AnnouncementAcksResult> {
  return walkAllPages<Acknowledgement>(
    (page) =>
      strapi<StrapiListResponse<Acknowledgement>>(
        `/api/acknowledgements?filters[targetType][$eq]=announcement${params}&sort=id:asc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
        { noCache: true },
      ),
    { maxPages: MAX_PAGES, label: "announcement acknowledgements" },
  ).then(({ data, truncated }) => ({ acks: data, truncated }));
}

/** The caller's own announcement acknowledgements (policy-scoped to self). */
export function fetchMyAnnouncementAcks(): Promise<AnnouncementAcksResult> {
  return fetchAllAnnouncementAcksPaged("");
}

/**
 * ALL announcement acknowledgements incl. the acknowledging user —
 * only useful for admin_role (everyone else gets their own rows back).
 */
export function fetchAllAnnouncementAcks(): Promise<AnnouncementAcksResult> {
  return fetchAllAnnouncementAcksPaged("&populate[user]=true");
}
