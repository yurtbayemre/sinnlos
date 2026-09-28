/**
 * Thin Strapi v5 fetch client used from Server Components, Server Actions
 * and Route Handlers. The caller's Strapi JWT (issued by the
 * users-permissions Microsoft provider or local sign-in, read through
 * getStrapiToken() in lib/session.ts) is injected automatically.
 *
 * Caching contract (D-DC01, deep-dive decisions/03-caching.md §1-§5):
 *   - The web keeps NO server-side copy of Strapi responses between
 *     requests: no Next fetch/Data Cache entry, none of the next/cache
 *     cache APIs or cache directives (the ESLint rules list them), no
 *     in-process memo of response bodies. Every request is sent with
 *     cache: "no-store"; StrapiInit rejects `cache`/`next` and strapi()
 *     strips both at runtime. Why: the Data Cache key hashes every
 *     request header, Authorization included, so the old tagged reads were
 *     one entry per JWT — reused only by the same user, served stale while
 *     revalidating (also to a since-blocked user or an expired JWT) and
 *     never evicted from disk. Per-user policies (wiki, announcements,
 *     documents, quick links, contact-field sanitising) make most responses
 *     unshareable anyway.
 *   - Reuse happens within ONE request only: identical GETs (same URL and
 *     headers) in one RSC render are merged by Next's fetch dedupe,
 *     getSession() decodes the session once per render and getViewer()
 *     (lib/viewer.ts, D-SESSION-01) reads the caller's own /api/me once per
 *     render. Server Actions and Route Handlers get none of these.
 *   - Freshness: a committed Strapi write shows on the next server render
 *     (navigation, reload, refresh() in an action, router.refresh()) — no
 *     webhook involved. While Strapi is down pages show the FetchErrorBanner
 *     (lib/safe-fetch.ts), never an old list.
 *   - Never wrap strapi() in React cache(): it also performs mutations.
 *   - No route-segment `export const fetchCache` outside the *-no-store
 *     values: "force-cache" overrides this no-store inside Next's patched
 *     fetch (revalidate 0 becomes an infinite entry per JWT), which no
 *     argument handling here can prevent.
 * Guarded by the StrapiInit type, the D-DC01 rules in
 * apps/web/eslint.config.mjs and strapi.test.ts. A server-side cache may
 * only come back under the decision's re-entry rule (§10).
 */
import { redirect } from "next/navigation";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { demo } from "@/lib/demo";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { getStrapiToken } from "@/lib/session";
import { StrapiError } from "@/lib/strapi-error";
import type { Poll, PollResults } from "@/lib/types";

export type StrapiListResponse<T> = {
  data: T[];
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } };
};

/**
 * A plain RequestInit minus the cache knobs: every strapi() call is
 * no-store (see the contract above), so `cache` and `next` are rejected at
 * compile time — and stripped at runtime for a caller that casts past this.
 */
export type StrapiInit = Omit<RequestInit, "cache" | "next">;

export async function strapi<T>(path: string, init: StrapiInit = {}): Promise<T> {
  // DEMO_MODE answers from fixtures before any session read or fetch.
  if (DEMO_MODE) {
    return demo(path) as T;
  }
  const token = await getStrapiToken();

  // Runtime strip on top of the StrapiInit type: a caller that casts its way
  // past the type must still never reach the Data Cache.
  const { headers: callerHeaders, ...rest } = init as RequestInit;
  delete rest.cache;
  delete rest.next;

  const headers = new Headers(callerHeaders);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  // `cache` is written LAST so nothing spread before it can override it.
  const res = await fetch(`${STRAPI_URL}${path}`, { ...rest, headers, cache: "no-store" });

  // The session's Strapi JWT was rejected (expired, or the CMS JWT secret
  // was rotated). The only fix is re-authenticating, so send the user to
  // the sign-in page instead of surfacing a cryptic 401 everywhere. Without
  // a token a 401 is a plain error (nothing to re-authenticate).
  // redirect() throws NEXT_REDIRECT, which Next.js handles in Server
  // Components, Server Actions and Route Handlers alike; catch-all
  // wrappers rethrow it via unstable_rethrow (see lib/safe-fetch.ts).
  if (res.status === 401 && token) {
    redirect("/sign-in?expired=1");
  }

  if (!res.ok) {
    throw new StrapiError(res.status, res.statusText, await res.text());
  }

  // DELETE answers 204 with an empty body — res.json() would throw on it.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Most event documentIds per RSVP summary request (the cms caps it at 50). */
const RSVP_SUMMARY_CHUNK = 50;

/**
 * The /events list split (FX49). "Running": a timed event whose end is
 * still ahead (end >= now), or an all-day event whose last day is today or
 * later (end >= the start of today; all-day days are the APP_TIME_ZONE days
 * of start through end, decision 04 C7, and its end may be any time on its
 * last day). Upcoming = started today or later, or running. Past = the
 * exact complement: started before today and not running, spelled out for
 * SQL's three-valued logic: no end, an end before today, or an end before
 * now on an event that is not all-day (allDay false, or NULL on rows older
 * than the attribute). Both take ISO-Z instants.
 */
export function eventsUpcomingFilter(startOfTodayIso: string, nowIso: string): string {
  const today = encodeURIComponent(startOfTodayIso);
  const now = encodeURIComponent(nowIso);
  return (
    `filters[$or][0][start][$gte]=${today}` +
    `&filters[$or][1][end][$gte]=${now}` +
    `&filters[$or][2][allDay][$eq]=true&filters[$or][2][end][$gte]=${today}`
  );
}

export function eventsPastFilter(startOfTodayIso: string, nowIso: string): string {
  const today = encodeURIComponent(startOfTodayIso);
  const now = encodeURIComponent(nowIso);
  return (
    `filters[start][$lt]=${today}` +
    `&filters[$or][0][end][$null]=true` +
    `&filters[$or][1][end][$lt]=${today}` +
    `&filters[$or][2][end][$lt]=${now}&filters[$or][2][allDay][$eq]=false` +
    `&filters[$or][3][end][$lt]=${now}&filters[$or][3][allDay][$null]=true`
  );
}

/**
 * Convenience helpers for the main collections. Every read is uncached
 * (contract above); the field-limited user populates below are data
 * minimisation — a consumer gets only the columns it renders.
 */
export const api = {
  departments: {
    // The list view (and the dashboard/search consumers) only ever renders
    // the department's own fields + team/member COUNTS — never a head/member
    // contact field. Field-limit the `head` user relation to non-sensitive
    // columns so NO sensitive field (email/phone/hireDate/officeLocation/
    // microsoftOid) is in the payload: data minimisation, the list never
    // needs them (issue #10 / F1). No headerImage (WD05): no page renders
    // it, here or on the detail page.
    // Walks every page: without an explicit pageSize Strapi serves only
    // `api.rest.defaultLimit` = 25 rows, so department #26 silently vanished
    // from the index, the dashboard count and the search preload (issue #26).
    // Secondary sort on id keeps the walk stable — `name` is not unique.
    // Hard cap: 10 pages x 100 = 1000 departments.
    list: (): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/departments?populate[head][fields][0]=displayName&populate[head][fields][1]=jobTitle&populate[teams]=true&sort[0]=name:asc&sort[1]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 10, label: "departments" },
      ),
    // Per-user response: the detail page shows the head's and each member's
    // email as the internal contact line (`jobTitle ?? email`), and the CMS
    // content-api sanitizer strips email for non-privileged callers — a
    // guest and a member get different payloads for the same URL (issue #10
    // / F1, same as people/wiki).
    //
    // No page walk needed here: `slug` is a uid attribute (unique), so the
    // top-level result is 0..1 rows — the defaultLimit of 25 only bounds
    // top-level pagination, and Strapi 5 REST does not paginate populated
    // relations (teams/members arrive in full).
    one: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/departments?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[head]=true&populate[teams][populate][lead]=true&populate[members]=true`,
      ),
  },
  teams: {
    // Field-limited like departments.list: the list/dashboard/search consumers
    // use only team fields + member COUNT, never a lead/member contact field,
    // so the `lead`/`members` user relations are limited to non-sensitive
    // columns (data minimisation, issue #10 / F1).
    //
    // Walks every page (issue #26): the old single request sent no pageSize
    // and stopped at Strapi's defaultLimit of 25, so team #26 was missing
    // from the index, the dashboard count and the search preload. Secondary
    // sort on id keeps the walk stable — `name` is not unique. Hard cap:
    // 20 pages x 100 = 2000 teams (parity with lib/teams.ts MAX_PAGES).
    list: (): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/teams?populate[department]=true&populate[lead][fields][0]=displayName&populate[lead][fields][1]=jobTitle&populate[members][fields][0]=displayName&populate[members][fields][1]=jobTitle&sort[0]=name:asc&sort[1]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 20, label: "teams" },
      ),
    // Per-user response: the detail page renders the lead's and members'
    // email as the internal contact line (`jobTitle ?? email`), which the
    // sanitizer strips for non-privileged callers (issue #10 / F1, same as
    // departments.one).
    //
    // No page walk needed: `slug` is a uid attribute (unique) → 0..1 top-level
    // rows; populated relations are not paginated by Strapi 5 REST.
    // No populate[pages]: the page never rendered it, and the CMS strips it
    // for non-admin/editor callers anyway (global relation guard, FX05).
    one: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/teams?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[department]=true&populate[lead]=true&populate[members]=true`,
      ),
  },
  wiki: {
    // All wiki responses are per-user: the wiki-visibility policy filters
    // results per caller, so the same URL yields different pages for
    // different users. Strapi is on the internal Docker network so the
    // round-trip cost is low.
    //
    // Walks every page (issue #26): without a pageSize the wiki index stopped
    // at Strapi's defaultLimit of 25 and whole knowledge-base sections fell
    // out of the index and the search preload. Secondary sort on id keeps the
    // walk stable. Hard cap: 10 pages x 100 = 1000 spaces.
    spaces: (): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/wiki-spaces?populate[department]=true&populate[team]=true&sort[0]=name:asc&sort[1]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 10, label: "wiki spaces" },
      ),
    // No page walk for space()/page(): `slug` is a uid attribute (unique) →
    // 0..1 top-level rows; the defaultLimit of 25 bounds only top-level
    // pagination, and Strapi 5 REST does not paginate populated relations
    // (the space's pages arrive in full).
    //
    // Field-limited (FX24, WD05): the space page lists each page's title,
    // slug and summary only, so neither the page bodies nor an author are
    // loaded (Strapi always adds id and documentId).
    space: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/wiki-spaces?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[pages][fields][0]=title&populate[pages][fields][1]=slug&populate[pages][fields][2]=summary`,
      ),
    // No revisions (FX24): every view used to transfer the full body of
    // every historical revision, and none was rendered. The byline needs
    // the author's and last editor's names only; `id` tells them apart.
    page: (spaceSlug: string, pageSlug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/wiki-pages?filters[space][slug][$eq]=${encodeURIComponent(spaceSlug)}&filters[slug][$eq]=${encodeURIComponent(pageSlug)}&populate[author][fields][0]=displayName&populate[author][fields][1]=username&populate[lastEditor][fields][0]=displayName&populate[lastEditor][fields][1]=username&populate[space][fields][0]=name&populate[space][fields][1]=slug`,
      ),
  },
  announcements: {
    // No audience filter here: targeting (audience/department/team/
    // audienceRoles) is enforced server-side by the CMS policy
    // `announcement-visibility`, which injects an id filter per caller.
    // The old client-side `$or` was redundant for department scoping and
    // silently missed team- and role-scoped posts entirely. These responses
    // are therefore per-user.
    //
    // pageSize=20 is a deliberate feed/render cap (issue #26). Anyone who
    // needs a COUNT must read `meta.pagination.total` (the count() pattern
    // from manage/analytics), never `data.length` — the total is correct
    // per user because the visibility policy filters the query before the
    // count. No department populate (WD05): no card renders it.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/announcements?populate[author][fields][0]=username&populate[author][fields][1]=email&populate[author][fields][2]=displayName&populate[author][fields][3]=jobTitle&sort=pinned:desc,createdAt:desc&pagination[pageSize]=20",
      ),
    // Mandatory-read announcements for the ack banner and the pinned
    // "open confirmations" section on /announcements — same visibility
    // basis as list(), narrowed to requiresAck (a plain boolean
    // attribute, so the filter validates for every reading role). Author
    // fields are populated (same as list()) so cards rendered from this
    // query are complete; the banner just ignores them.
    //
    // A single request is bounded by its pageSize, so this walks every page
    // — dropping mandatory announcements past the first page would silently
    // undercount open confirmations in the banner and report (issue #14).
    // Secondary sort on id keeps the page walk stable when many rows share
    // the same createdAt. Hard cap: 50 pages x 100 = 5000 mandatory posts.
    requiringAck: (): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/announcements?filters[requiresAck][$eq]=true&populate[author][fields][0]=username&populate[author][fields][1]=email&populate[author][fields][2]=displayName&populate[author][fields][3]=jobTitle&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 50, label: "mandatory announcements" },
      ),
  },
  events: {
    // Time-window fetches instead of one global list: a plain
    // sort=start:asc&pageSize=50 returns the 50 OLDEST events and starves
    // the calendar once history grows. Callers pass the first instant of
    // today in APP_TIME_ZONE (plain-date.zonedDayStart) and now, both ISO-Z,
    // so events that began earlier today still count as upcoming.
    //
    // The `organizer` user relation is field-limited to displayName — the only
    // organizer field any events consumer renders (`organizedBy { name }`). No
    // sensitive user field enters the payload (data minimisation, issue #10 /
    // F1). No departments populate (WD05): no events consumer renders them.
    //
    // Upcoming events, soonest first: start >= the start of today, OR still
    // running (FX49): a timed event whose end is still ahead, an all-day
    // event whose last day is today or later (C7: its days run through the
    // day of its end). Before, a multi-day event dropped under "Past" on its
    // second day. pageSize=50 is a deliberate feed/render cap (issue #26) —
    // counts must come from `meta.pagination.total`, never `data.length`
    // (see the dashboard).
    upcoming: (startOfTodayIso: string, nowIso: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?${eventsUpcomingFilter(startOfTodayIso, nowIso)}&populate[organizer][fields][0]=displayName&sort=start:asc&pagination[pageSize]=50`,
      ),
    // The most recent past events, newest first — the list view shows only
    // this small tail of history: started before today and not running, the
    // exact complement of `upcoming` (no event is listed twice, none is lost).
    past: (startOfTodayIso: string, nowIso: string, limit = 10) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?${eventsPastFilter(startOfTodayIso, nowIso)}&populate[organizer][fields][0]=displayName&sort=start:desc&pagination[pageSize]=${limit}`,
      ),
    // Events overlapping the half-open window [from, to) for the month
    // grid — multi-day spans included: start < window end AND
    // (end ?? start) >= window start ($or handles the nullable end).
    // pageSize=100 is a deliberate render cap (issue #26): a single month
    // with >100 events would drop entries from the grid, with no truncated
    // signal on this path — accepted as far beyond realistic volume.
    window: (fromIso: string, toIso: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$lt]=${encodeURIComponent(toIso)}&filters[$or][0][end][$gte]=${encodeURIComponent(fromIso)}&filters[$or][1][end][$null]=true&filters[$or][1][start][$gte]=${encodeURIComponent(fromIso)}&populate[organizer][fields][0]=displayName&sort=start:asc&pagination[pageSize]=100`,
      ),
    // RSVP summaries for a set of events (FX21): the CMS aggregates the
    // counts, the "yes" names and the caller's own answer
    // (GET /api/event-rsvps/summary), so no RSVP row and no decliner name
    // reaches the web; this replaced a walk of up to 3000 rows per view.
    // Per-user (myStatus). Guests never call this (no summary grant — the
    // page skips the fetch). The endpoint takes at most 50 targets per
    // request; the events list shows at most 50, so this is one request,
    // chunked only as a safeguard.
    rsvpSummaries: async (documentIds: string[]): Promise<{ data: unknown[] }> => {
      const chunks: string[][] = [];
      for (let i = 0; i < documentIds.length; i += RSVP_SUMMARY_CHUNK) {
        chunks.push(documentIds.slice(i, i + RSVP_SUMMARY_CHUNK));
      }
      const pages = await Promise.all(
        chunks.map((chunk) =>
          strapi<{ data?: unknown }>(
            `/api/event-rsvps/summary?targets=${chunk.map(encodeURIComponent).join(",")}`,
          ),
        ),
      );
      return { data: pages.flatMap((page) => (Array.isArray(page?.data) ? page.data : [])) };
    },
  },
  polls: {
    // Per-user: the CMS poll-visibility policy filters the list to the
    // polls the caller may see (department targeting, decision 02), so a
    // department change applies on the next request (reads are never
    // cached, D-DC01). The cards are built from the per-user results()
    // endpoint, which also says whether the caller may vote and which
    // departments a poll targets, so the list populates no departments.
    //
    // No `author` populate (WD05): no poll consumer renders the author.
    //
    // pageSize=20 is a deliberate feed/render cap (issue #26) — counts must
    // come from `meta.pagination.total`, never `data.length`.
    list: () =>
      strapi<StrapiListResponse<Poll>>("/api/polls?sort=createdAt:desc&pagination[pageSize]=20"),
    results: (id: number) => strapi<PollResults>(`/api/polls/${id}/results`),
  },
  documents: {
    // Per-user: document-visibility filters per caller (department scoping)
    // — same as wiki/people/announcements.
    //
    // Walks every page (issue #26 follow-up): the documents page is a
    // complete library grouped by category with no pagination UI, so the old
    // pageSize=50 render cap silently hid document #51+. Secondary sort on id
    // keeps the walk stable — `updatedAt` is not unique. Hard cap: 10 pages
    // x 100 = 1000 documents.
    list: (): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/documents?populate[file]=true&populate[departments]=true&populate[uploadedBy]=true&sort[0]=updatedAt:desc&sort[1]=id:desc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 10, label: "documents" },
      ),
  },
  kudos: {
    // pageSize=30 is a deliberate feed/render cap (issue #26) — counts must
    // come from `meta.pagination.total`, never `data.length`.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/kudos-entries?populate[from]=true&populate[to]=true&sort=createdAt:desc&pagination[pageSize]=30",
      ),
  },
  classifieds: {
    // After create/renew the author sees the change immediately: the actions
    // call refresh() and every read here is uncached (contract above).
    // Author populate is field-limited; email is needed for the mailto
    // contact button on the detail page (company-internal address).
    //
    // Both list endpoints walk every page — a single request is bounded by
    // its pageSize, so a busy board would silently lose every ad past the
    // first 100 (issue #14). Secondary sort on id keeps the walk stable
    // when many ads share a createdAt. Hard cap: 50 pages x 100 = 5000 ads.
    // `today` is the calendar date 'YYYY-MM-DD' in APP_TIME_ZONE
    // (classified-shared.classifiedToday): expiresAt is a date column, and an
    // ad expiring today stays listed for the rest of that day.
    list: (today: string, category?: string): Promise<WalkResult<any>> => {
      const categoryFilter = category
        ? `&filters[category][$eq]=${encodeURIComponent(category)}`
        : "";
      return walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/classifieds?filters[expiresAt][$gte]=${encodeURIComponent(today)}${categoryFilter}&populate[images]=true&populate[author][fields][0]=displayName&populate[author][fields][1]=email&populate[author][fields][2]=jobTitle&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 50, label: "marketplace ads" },
      );
    },
    // Own ads including expired ones (renew UI). The author filter is a
    // user-relation traversal — fine for every posting role (all hold
    // user.find), and guests never reach this query.
    mine: (userId: number): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/classifieds?filters[author][id][$eq]=${userId}&populate[images]=true&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 50, label: "own marketplace ads" },
      ),
    one: (id: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/classifieds?filters[id][$eq]=${encodeURIComponent(id)}&populate[images]=true&populate[author][fields][0]=displayName&populate[author][fields][1]=email&populate[author][fields][2]=jobTitle`,
      ),
  },
  quickLinks: {
    // Per-user: the quick-link-visibility policy filters by the caller's
    // department. Deliberately NO populate of `departments`: the policy scopes
    // server-side, and populating the relation would 400 for roles
    // without department.find (guest).
    //
    // Walks every page (issue #26): the list is curated and stays well below
    // 100 links, so this still costs exactly one request (the walk stops at
    // pageCount=1) — but if it ever grows past 100 nothing is silently lost.
    // Secondary sort on id keeps the walk stable. Hard cap: 5 x 100 = 500.
    list: (): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/quick-links?sort[0]=order:asc&sort[1]=label:asc&sort[2]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 5, label: "quick links" },
      ),
  },
  celebrations: () => strapi<{ data: any[] }>("/api/celebrations?window=30"),
};
