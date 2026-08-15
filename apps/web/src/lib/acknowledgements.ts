import { strapi, type StrapiListResponse } from "@/lib/strapi";
import type { Acknowledgement } from "@/lib/types";

/**
 * Server-side helpers around /api/acknowledgements.
 *
 * The acknowledgement-visibility policy scopes reads to the caller's own
 * rows (admin_role bypasses), so every fetch here MUST use noCache —
 * the Next.js fetch cache keys by URL only and would leak one user's
 * acknowledgement state to everyone else.
 *
 * Strapi's REST maxLimit caps pageSize at 100, so both helpers walk the
 * pagination until exhausted (bounded by a hard safety cap).
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

async function fetchAllAnnouncementAcksPaged(params: string): Promise<Acknowledgement[]> {
  const all: Acknowledgement[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await strapi<StrapiListResponse<Acknowledgement>>(
      `/api/acknowledgements?filters[targetType][$eq]=announcement${params}&sort=id:asc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
      { noCache: true },
    );
    const batch = res?.data ?? [];
    all.push(...batch);
    const pagination = res?.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
  }
  return all;
}

/** The caller's own announcement acknowledgements (policy-scoped to self). */
export function fetchMyAnnouncementAcks(): Promise<Acknowledgement[]> {
  return fetchAllAnnouncementAcksPaged("");
}

/**
 * ALL announcement acknowledgements incl. the acknowledging user —
 * only useful for admin_role (everyone else gets their own rows back).
 */
export function fetchAllAnnouncementAcks(): Promise<Acknowledgement[]> {
  return fetchAllAnnouncementAcksPaged("&populate[user]=true");
}
