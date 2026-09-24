/**
 * Thin Strapi v5 fetch client used from Server Components, Server Actions
 * and Route Handlers. The caller's Strapi JWT (issued by the
 * users-permissions Microsoft provider or local sign-in, read through
 * getStrapiToken() in lib/session.ts) is injected automatically.
 *
 * Caching contract (D-DC01, deep-dive decisions/03-caching.md §1-§5):
 *   - The web keeps NO server-side copy of Strapi responses between
 *     requests: no Next fetch/Data Cache entry, no unstable_cache, no
 *     'use cache', no in-process memo of response bodies. Every request is
 *     sent with cache: "no-store"; StrapiInit rejects `cache`/`next` and
 *     strapi() strips both at runtime. Why: the Data Cache key hashes every
 *     request header, Authorization included, so the old tagged reads were
 *     one entry per JWT — reused only by the same user, served stale while
 *     revalidating (also to a since-blocked user or an expired JWT) and
 *     never evicted from disk. Per-user policies (wiki, announcements,
 *     documents, quick links, contact-field sanitising) make most responses
 *     unshareable anyway.
 *   - Reuse happens within ONE request only: identical GETs (same URL and
 *     headers) in one RSC render are merged by Next's fetch dedupe, and
 *     getSession() decodes the session once per render. Server Actions and
 *     Route Handlers get neither.
 *   - Freshness: a committed Strapi write shows on the next server render
 *     (navigation, reload, refresh() in an action, router.refresh()) — no
 *     webhook involved. While Strapi is down pages show the FetchErrorBanner
 *     (lib/safe-fetch.ts), never an old list.
 *   - Never wrap strapi() in React cache(): it also performs mutations.
 * Guarded by the StrapiInit type, the next/cache rules in
 * apps/web/eslint.config.mjs and strapi.test.ts. A server-side cache may
 * only come back under the decision's re-entry rule (§10).
 */
import { redirect } from "next/navigation";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { demo } from "@/lib/demo";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { getStrapiToken } from "@/lib/session";

export type StrapiListResponse<T> = {
  data: T[];
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } };
};

/**
 * A plain RequestInit minus the cache knobs: every strapi() call is
 * no-store (see the contract above), so `cache` and `next` are rejected at
 * compile time — and stripped at runtime for a caller that casts past this.
 */
export type StrapiInit = Omit<RequestInit, "cache" | "next"> & {
  /**
   * @deprecated No-op since D-DC01 — every request is no-store. Kept only
   * until the call sites drop it (next commit); do not add new uses.
   */
  noCache?: boolean;
};

export async function strapi<T>(path: string, init: StrapiInit = {}): Promise<T> {
  // DEMO_MODE answers from fixtures before any session read or fetch.
  if (DEMO_MODE) {
    return demo(path) as T;
  }
  const token = await getStrapiToken();

  // Runtime strip on top of the StrapiInit type: a caller that casts its way
  // past the type must still never reach the Data Cache.
  const { headers: callerHeaders, ...rest } = init as RequestInit & Pick<StrapiInit, "noCache">;
  delete rest.cache;
  delete rest.next;
  delete rest.noCache;

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
    const body = await res.text();
    throw new Error(`Strapi ${res.status} ${res.statusText}: ${body}`);
  }

  // DELETE answers 204 with an empty body — res.json() would throw on it.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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
    // needs them (issue #10 / F1).
    // Walks every page: without an explicit pageSize Strapi serves only
    // `api.rest.defaultLimit` = 25 rows, so department #26 silently vanished
    // from the index, the dashboard count and the search preload (issue #26).
    // Secondary sort on id keeps the walk stable — `name` is not unique.
    // Hard cap: 10 pages x 100 = 1000 departments.
    list: (): Promise<WalkResult<any>> =>
      walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/departments?populate[head][fields][0]=displayName&populate[head][fields][1]=jobTitle&populate[teams]=true&populate[headerImage]=true&sort[0]=name:asc&sort[1]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
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
        `/api/departments?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[head]=true&populate[teams][populate][lead]=true&populate[members]=true&populate[headerImage]=true`,
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
    // (pages/revisions arrive in full).
    space: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/wiki-spaces?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[pages][populate][author]=true`,
      ),
    page: (spaceSlug: string, pageSlug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/wiki-pages?filters[space][slug][$eq]=${encodeURIComponent(spaceSlug)}&filters[slug][$eq]=${encodeURIComponent(pageSlug)}&populate[author]=true&populate[lastEditor]=true&populate[space]=true&populate[revisions][populate][editor]=true`,
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
    // count.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/announcements?populate[author][fields][0]=username&populate[author][fields][1]=email&populate[author][fields][2]=displayName&populate[author][fields][3]=jobTitle&populate[department]=true&sort=pinned:desc,createdAt:desc&pagination[pageSize]=20",
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
    // the calendar once history grows. Callers pass local start-of-day ISO
    // stamps, so events that began earlier today still count as upcoming.
    //
    // The `organizer` user relation is field-limited to displayName — the only
    // organizer field any events consumer renders (`organizedBy { name }`). No
    // sensitive user field enters the payload (data minimisation, issue #10 /
    // F1).
    //
    // Upcoming events (start >= from), soonest first. pageSize=50 is a
    // deliberate feed/render cap (issue #26) — counts must come from
    // `meta.pagination.total`, never `data.length` (see the dashboard).
    upcoming: (fromIso: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$gte]=${encodeURIComponent(fromIso)}&populate[departments]=true&populate[organizer][fields][0]=displayName&sort=start:asc&pagination[pageSize]=50`,
      ),
    // The most recent past events (start < before), newest first — the
    // list view shows only this small tail of history.
    past: (beforeIso: string, limit = 10) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$lt]=${encodeURIComponent(beforeIso)}&populate[departments]=true&populate[organizer][fields][0]=displayName&sort=start:desc&pagination[pageSize]=${limit}`,
      ),
    // Events overlapping the half-open window [from, to) for the month
    // grid — multi-day spans included: start < window end AND
    // (end ?? start) >= window start ($or handles the nullable end).
    // pageSize=100 is a deliberate render cap (issue #26): a single month
    // with >100 events would drop entries from the grid, with no truncated
    // signal on this path — accepted as far beyond realistic volume.
    window: (fromIso: string, toIso: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$lt]=${encodeURIComponent(toIso)}&filters[$or][0][end][$gte]=${encodeURIComponent(fromIso)}&filters[$or][1][end][$null]=true&filters[$or][1][start][$gte]=${encodeURIComponent(fromIso)}&populate[departments]=true&populate[organizer][fields][0]=displayName&sort=start:asc&pagination[pageSize]=100`,
      ),
    // RSVP rows for a set of events. Per-user: the response contains the
    // caller's own answer (myStatus is derived from it). The filter targets
    // the plain string column targetDocumentId (no relation traversal);
    // the user populate is field-limited to displayName. Guests never call
    // this (no event-rsvp.find grant — the page skips the fetch).
    // A single request is bounded by its pageSize, so this walks the
    // pagination. Hard upper bound: 30 pages x 100 rows = 3000 rows,
    // comfortably above 50 visible events with full attendance while still
    // bounding a runaway loop (issue #14).
    rsvps: (documentIds: string[]): Promise<WalkResult<any>> => {
      const filters = documentIds
        .map((d, i) => `filters[targetDocumentId][$in][${i}]=${encodeURIComponent(d)}`)
        .join("&");
      return walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            // Secondary sort on id keeps the page walk stable when many
            // rows share the same respondedAt (no skips/duplicates).
            `/api/event-rsvps?${filters}&populate[user][fields][0]=displayName&sort[0]=respondedAt:asc&sort[1]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
          ),
        { maxPages: 30, label: "event RSVPs" },
      );
    },
  },
  polls: {
    // The `author` user relation is field-limited to displayName: no poll
    // consumer renders an author contact field (the poll cards are built from
    // the per-user results() endpoint), so no sensitive user field enters the
    // payload (data minimisation, issue #10 / F1).
    //
    // pageSize=20 is a deliberate feed/render cap (issue #26) — counts must
    // come from `meta.pagination.total`, never `data.length`.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/polls?populate[departments]=true&populate[author][fields][0]=displayName&sort=createdAt:desc&pagination[pageSize]=20",
      ),
    results: (id: number) => strapi<any>(`/api/polls/${id}/results`),
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
    list: (todayIso: string, category?: string): Promise<WalkResult<any>> => {
      const categoryFilter = category
        ? `&filters[category][$eq]=${encodeURIComponent(category)}`
        : "";
      return walkAllPages<any>(
        (page) =>
          strapi<StrapiListResponse<any>>(
            `/api/classifieds?filters[expiresAt][$gte]=${encodeURIComponent(todayIso)}${categoryFilter}&populate[images]=true&populate[author][fields][0]=displayName&populate[author][fields][1]=email&populate[author][fields][2]=jobTitle&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[page]=${page}&pagination[pageSize]=100`,
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
