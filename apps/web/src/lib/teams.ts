import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { walkAllPages } from "@/lib/paginate";
import type { TeamMembership } from "@/lib/audience";

/**
 * Server-side helper for reading the COMPLETE team roster.
 *
 * Why this exists — the silent 25-row cap:
 *   `api.teams.list()` used to pass no `pagination[pageSize]`, so Strapi
 *   applied `api.rest.defaultLimit` = 25 (@strapi/core 5.49
 *   `core-api/service/pagination.js:9`; this CMS sets no override). Any
 *   consumer that needs the FULL mapping — the acknowledgement report
 *   builds user → teams from it, because `team.lead` has no inverse field
 *   on the user — would silently lose every team past the 25th and then
 *   compute an EMPTY target audience for team-scoped announcements, which
 *   the report used to render as a green "everyone confirmed".
 *   (`api.teams.list()` walks its pages too since #26, but it populates
 *   display fields this roster does not need — see below.)
 *
 * So we walk the pagination like `fetchAllAnnouncementAcks` /
 * `fetchAllUsers` do, and report back whether the walk actually finished:
 * an incomplete roster must NOT be mistaken for "this user is in no team".
 *
 * The user populates are field-limited: only the ids are needed, and `id`
 * is returned regardless of `fields` (same pattern as the report's
 * `audienceRoles` populate). That also keeps member e-mail addresses out
 * of the Next.js fetch cache.
 *
 * Caching matches `api.teams.list()` (tag + 60 s): no visibility policy
 * runs on `api::team.team`, so the response is identical for every caller
 * and safe to share across users.
 */
const PAGE_SIZE = 100;
/**
 * Hard upper bound: 20 x 100 = 2000 teams. Far above any realistic
 * intranet roster, but it bounds a runaway loop if `pageCount` ever comes
 * back wrong. Hitting it sets `truncated`, so callers fail closed instead
 * of silently working off a partial roster.
 */
const MAX_PAGES = 20;

export interface AllTeamsResult {
  teams: TeamMembership[];
  /** true when the page walk stopped at MAX_PAGES with pages left over. */
  truncated: boolean;
}

export async function fetchAllTeams(): Promise<AllTeamsResult> {
  const { data: teams, truncated } = await walkAllPages<TeamMembership>(
    (page) =>
      strapi<StrapiListResponse<TeamMembership>>(
        // sort=id:asc keeps the page walk stable (Postgres returns rows in
        // an undefined order without ORDER BY, so pages could skip rows).
        `/api/teams?populate[lead][fields][0]=username&populate[members][fields][0]=username&sort=id:asc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
        { tag: "teams", revalidate: 60 },
      ),
    { maxPages: MAX_PAGES, label: "team roster" },
  );

  return { teams, truncated };
}
