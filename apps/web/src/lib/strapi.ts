/**
 * Thin Strapi v5 fetch client used from Server Components and Server Actions.
 * The Strapi JWT (issued by the users-permissions Microsoft provider and
 * stored in the Auth.js session) is injected automatically.
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { demo } from "@/lib/demo";
import { walkAllPages, type WalkResult } from "@/lib/paginate";

export type StrapiListResponse<T> = {
  data: T[];
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } };
};
export type StrapiEntityResponse<T> = { data: T };

export interface FetchOptions extends RequestInit {
  /** Next.js cache tag for revalidation. Ignored when `noCache` is true. */
  tag?: string;
  /** ISR revalidation interval in seconds. Ignored when `noCache` is true. */
  revalidate?: number;
  /** Override the strapi JWT (e.g. during login callback). */
  tokenOverride?: string;
  /**
   * Bypass the Next.js fetch cache entirely. Required for endpoints whose
   * Strapi responses vary by user (e.g. anything gated by the
   * wiki-visibility policy), because the fetch cache keys by URL only —
   * not by Authorization header, so cached responses leak across users.
   */
  noCache?: boolean;
}

export async function strapi<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  if (DEMO_MODE) {
    return demo(path) as T;
  }
  const session = await auth();
  const token = opts.tokenOverride ?? session?.strapiJwt ?? null;

  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const fetchInit: RequestInit = {
    ...opts,
    headers,
  };
  if (opts.noCache) {
    fetchInit.cache = "no-store";
  } else {
    (fetchInit as RequestInit & { next?: unknown }).next = {
      revalidate: opts.revalidate,
      tags: opts.tag ? [opts.tag] : undefined,
    };
  }

  const res = await fetch(`${STRAPI_URL}${path}`, fetchInit);

  // The session's Strapi JWT was rejected (expired, or the CMS JWT secret
  // was rotated). The only fix is re-authenticating, so send the user to
  // the sign-in page instead of surfacing a cryptic 401 everywhere.
  // redirect() throws NEXT_REDIRECT, which Next.js handles in Server
  // Components, Server Actions and Route Handlers alike; catch-all
  // wrappers rethrow it via unstable_rethrow (see lib/safe-fetch.ts).
  if (res.status === 401 && token && !opts.tokenOverride) {
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

/** Convenience helpers for the main collections. */
export const api = {
  departments: {
    // The list view (and the dashboard/search consumers) only ever renders
    // the department's own fields + team/member COUNTS — never a head/member
    // contact field. Field-limit the `head` user relation to non-sensitive
    // columns so NO sensitive field (email/phone/hireDate/officeLocation/
    // microsoftOid) is in the payload: the response is then role-invariant and
    // may safely stay in the URL-keyed fetch cache (issue #10 / F1 — the
    // content-api sanitizer runs per-request and would otherwise be bypassed
    // by a cache entry shared across roles).
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
            { tag: "departments", revalidate: 60 },
          ),
        { maxPages: 10, label: "departments" },
      ),
    // noCache: the detail page shows the head's and each member's email as the
    // internal contact line (`jobTitle ?? email`). That is a per-user response
    // — the CMS content-api sanitizer strips email for non-privileged callers,
    // so a URL-keyed cache would leak a member's cache entry (with email) to a
    // guest, and vice versa. Same rule as people/wiki (issue #10 / F1).
    //
    // No page walk needed here: `slug` is a uid attribute (unique), so the
    // top-level result is 0..1 rows — the defaultLimit of 25 only bounds
    // top-level pagination, and Strapi 5 REST does not paginate populated
    // relations (teams/members arrive in full).
    one: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/departments?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[head]=true&populate[teams][populate][lead]=true&populate[members]=true&populate[headerImage]=true`,
        { noCache: true },
      ),
  },
  teams: {
    // Field-limited like departments.list: the list/dashboard/search consumers
    // use only team fields + member COUNT, never a lead/member contact field,
    // so limiting the `lead`/`members` user relations to non-sensitive columns
    // keeps the payload role-invariant and cacheable (issue #10 / F1).
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
            { tag: "teams", revalidate: 60 },
          ),
        { maxPages: 20, label: "teams" },
      ),
    // noCache: the detail page renders the lead's and members' email as the
    // internal contact line (`jobTitle ?? email`) — a per-user response the
    // sanitizer strips for non-privileged callers, so it must not enter the
    // URL-keyed cache (issue #10 / F1, same as departments.one).
    //
    // No page walk needed: `slug` is a uid attribute (unique) → 0..1 top-level
    // rows; populated relations are not paginated by Strapi 5 REST.
    one: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/teams?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[department]=true&populate[lead]=true&populate[members]=true&populate[pages]=true`,
        { noCache: true },
      ),
  },
  wiki: {
    // All wiki endpoints bypass the Next.js fetch cache because the
    // wiki-visibility policy filters results per user — caching by URL
    // alone would leak restricted pages across users. Strapi is on the
    // internal Docker network so the round-trip cost is low.
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
            { noCache: true },
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
        { noCache: true },
      ),
    page: (spaceSlug: string, pageSlug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/wiki-pages?filters[space][slug][$eq]=${encodeURIComponent(spaceSlug)}&filters[slug][$eq]=${encodeURIComponent(pageSlug)}&populate[author]=true&populate[lastEditor]=true&populate[space]=true&populate[revisions][populate][editor]=true`,
        { noCache: true },
      ),
  },
  announcements: {
    // No audience filter here: targeting (audience/department/team/
    // audienceRoles) is enforced server-side by the CMS policy
    // `announcement-visibility`, which injects an id filter per caller.
    // The old client-side `$or` was redundant for department scoping and
    // silently missed team- and role-scoped posts entirely. noCache is
    // therefore mandatory — these responses are per-user.
    //
    // pageSize=20 is a deliberate feed/render cap (issue #26). Anyone who
    // needs a COUNT must read `meta.pagination.total` (the count() pattern
    // from manage/analytics), never `data.length` — the total is correct
    // per user because the visibility policy filters the query before the
    // count.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/announcements?populate[author][fields][0]=username&populate[author][fields][1]=email&populate[author][fields][2]=displayName&populate[author][fields][3]=jobTitle&populate[department]=true&sort=pinned:desc,createdAt:desc&pagination[pageSize]=20",
        { noCache: true },
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
            { noCache: true },
          ),
        { maxPages: 50, label: "mandatory announcements" },
      ),
  },
  events: {
    // Time-window fetches instead of one global list: a plain
    // sort=start:asc&pageSize=50 returns the 50 OLDEST events and starves
    // the calendar once history grows. All three share the "events" tag +
    // 60 s revalidate (same invalidation behavior as the old list()).
    // Callers pass local start-of-day ISO stamps so the cache key changes
    // at most once per day/month, not per request.
    //
    // The `organizer` user relation is field-limited to displayName — the only
    // organizer field any events consumer renders (`organizedBy { name }`). No
    // sensitive user field enters the payload, so these tagged/ISR-cached
    // responses stay role-invariant and never leak contact data across roles
    // via the URL-keyed cache (issue #10 / F1).
    //
    // Upcoming events (start >= from), soonest first. pageSize=50 is a
    // deliberate feed/render cap (issue #26) — counts must come from
    // `meta.pagination.total`, never `data.length` (see the dashboard).
    upcoming: (fromIso: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$gte]=${encodeURIComponent(fromIso)}&populate[departments]=true&populate[organizer][fields][0]=displayName&sort=start:asc&pagination[pageSize]=50`,
        { tag: "events", revalidate: 60 },
      ),
    // The most recent past events (start < before), newest first — the
    // list view shows only this small tail of history.
    past: (beforeIso: string, limit = 10) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$lt]=${encodeURIComponent(beforeIso)}&populate[departments]=true&populate[organizer][fields][0]=displayName&sort=start:desc&pagination[pageSize]=${limit}`,
        { tag: "events", revalidate: 60 },
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
        { tag: "events", revalidate: 60 },
      ),
    one: (id: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[id][$eq]=${encodeURIComponent(id)}&populate[departments]=true&populate[organizer][fields][0]=displayName`,
        { tag: `event:${id}`, revalidate: 60 },
      ),
    // RSVP rows for a set of events. noCache: the response contains the
    // caller's own answer (myStatus is derived from it) — user-variable
    // data must never enter the URL-keyed fetch cache. The filter targets
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
            { noCache: true },
          ),
        { maxPages: 30, label: "event RSVPs" },
      );
    },
  },
  polls: {
    // The `author` user relation is field-limited to displayName: no poll
    // consumer renders an author contact field (the poll cards are built from
    // the noCache results() endpoint), so limiting it keeps no sensitive user
    // field in this tagged/ISR-cached, role-invariant payload (issue #10 / F1).
    //
    // pageSize=20 is a deliberate feed/render cap (issue #26) — counts must
    // come from `meta.pagination.total`, never `data.length`.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/polls?populate[departments]=true&populate[author][fields][0]=displayName&sort=createdAt:desc&pagination[pageSize]=20",
        { tag: "polls", revalidate: 30 },
      ),
    results: (id: number) =>
      strapi<any>(`/api/polls/${id}/results`, { noCache: true }),
  },
  documents: {
    // noCache since document-visibility filters per user (department scoping):
    // the fetch cache keys by URL only, so a tagged cache would leak one
    // user's scoped list to others — same rule as wiki/people/announcements.
    //
    // pageSize=50 is a deliberate render cap (issue #26): the documents page
    // shows the 50 most recently updated files, no truncated signal. Counts
    // must come from `meta.pagination.total`, never `data.length`.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/documents?populate[file]=true&populate[departments]=true&populate[uploadedBy]=true&sort=updatedAt:desc&pagination[pageSize]=50",
        { noCache: true },
      ),
  },
  kudos: {
    // pageSize=30 is a deliberate feed/render cap (issue #26) — counts must
    // come from `meta.pagination.total`, never `data.length`.
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/kudos-entries?populate[from]=true&populate[to]=true&sort=createdAt:desc&pagination[pageSize]=30",
        { noCache: true },
      ),
  },
  classifieds: {
    // All classified endpoints bypass the fetch cache: after create/renew
    // the author must see the change immediately (the actions call
    // refresh()), and a tagged cache would need lifecycle invalidation for
    // no real gain — Strapi sits on the internal Docker network.
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
            { noCache: true },
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
            { noCache: true },
          ),
        { maxPages: 50, label: "own marketplace ads" },
      ),
    one: (id: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/classifieds?filters[id][$eq]=${encodeURIComponent(id)}&populate[images]=true&populate[author][fields][0]=displayName&populate[author][fields][1]=email&populate[author][fields][2]=jobTitle`,
        { noCache: true },
      ),
  },
  quickLinks: {
    // noCache: the quick-link-visibility policy filters per user's
    // department — caching by URL would leak scoped links across users.
    // Deliberately NO populate of `departments`: the policy scopes
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
            { noCache: true },
          ),
        { maxPages: 5, label: "quick links" },
      ),
  },
  celebrations: () =>
    strapi<{ data: any[] }>("/api/celebrations?window=30", { noCache: true }),
};
