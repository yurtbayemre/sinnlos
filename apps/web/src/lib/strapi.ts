/**
 * Thin Strapi v5 fetch client used from Server Components and Server Actions.
 * The Strapi JWT (issued by the users-permissions Microsoft provider and
 * stored in the Auth.js session) is injected automatically.
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { demo } from "@/lib/demo";

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
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/departments?populate[head]=true&populate[teams]=true&populate[headerImage]=true&sort=name:asc",
        { tag: "departments", revalidate: 60 },
      ),
    one: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/departments?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[head]=true&populate[teams][populate][lead]=true&populate[members]=true&populate[headerImage]=true`,
        { tag: `department:${slug}`, revalidate: 60 },
      ),
  },
  teams: {
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/teams?populate[department]=true&populate[lead]=true&populate[members]=true&sort=name:asc",
        { tag: "teams", revalidate: 60 },
      ),
    one: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/teams?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[department]=true&populate[lead]=true&populate[members]=true&populate[pages]=true`,
        { tag: `team:${slug}`, revalidate: 60 },
      ),
  },
  wiki: {
    // All wiki endpoints bypass the Next.js fetch cache because the
    // wiki-visibility policy filters results per user — caching by URL
    // alone would leak restricted pages across users. Strapi is on the
    // internal Docker network so the round-trip cost is low.
    spaces: () =>
      strapi<StrapiListResponse<any>>(
        "/api/wiki-spaces?populate[department]=true&populate[team]=true&sort=name:asc",
        { noCache: true },
      ),
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
  people: {
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/users?populate[department]=true&populate[avatar]=true&populate[role]=true&pagination[pageSize]=200&sort=displayName:asc",
        { noCache: true },
      ),
    one: (id: number) =>
      strapi<any>(
        `/api/users/${id}?populate[department]=true&populate[avatar]=true&populate[manager][populate][avatar]=true&populate[directReports][populate][avatar]=true&populate[teams][populate][department]=true&populate[role]=true`,
        { noCache: true },
      ),
  },
  announcements: {
    list: (departmentId?: number) => {
      let url = "/api/announcements?populate[author][fields][0]=username&populate[author][fields][1]=email&populate[author][fields][2]=displayName&populate[author][fields][3]=jobTitle&populate[department]=true&sort=pinned:desc,createdAt:desc&pagination[pageSize]=20";
      if (departmentId) {
        url += `&filters[$or][0][audience][$eq]=all&filters[$or][1][audience][$null]=true&filters[$or][2][department][id][$eq]=${departmentId}`;
      }
      return strapi<StrapiListResponse<any>>(url, { noCache: true });
    },
    // Mandatory-read announcements for the ack banner and the pinned
    // "open confirmations" section on /announcements. Same audience $or
    // filter as list(); requiresAck is a plain boolean attribute, so the
    // filter validates for every reading role. Author fields are
    // populated (same as list()) so cards rendered from this query are
    // complete; the banner just ignores them.
    requiringAck: (departmentId?: number) => {
      let url =
        "/api/announcements?filters[requiresAck][$eq]=true&populate[author][fields][0]=username&populate[author][fields][1]=email&populate[author][fields][2]=displayName&populate[author][fields][3]=jobTitle&sort=createdAt:desc&pagination[pageSize]=100";
      if (departmentId) {
        url += `&filters[$or][0][audience][$eq]=all&filters[$or][1][audience][$null]=true&filters[$or][2][department][id][$eq]=${departmentId}`;
      }
      return strapi<StrapiListResponse<any>>(url, { noCache: true });
    },
  },
  events: {
    // Time-window fetches instead of one global list: a plain
    // sort=start:asc&pageSize=50 returns the 50 OLDEST events and starves
    // the calendar once history grows. All three share the "events" tag +
    // 60 s revalidate (same invalidation behavior as the old list()).
    // Callers pass local start-of-day ISO stamps so the cache key changes
    // at most once per day/month, not per request.
    //
    // Upcoming events (start >= from), soonest first.
    upcoming: (fromIso: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$gte]=${encodeURIComponent(fromIso)}&populate[departments]=true&populate[organizer]=true&sort=start:asc&pagination[pageSize]=50`,
        { tag: "events", revalidate: 60 },
      ),
    // The most recent past events (start < before), newest first — the
    // list view shows only this small tail of history.
    past: (beforeIso: string, limit = 10) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$lt]=${encodeURIComponent(beforeIso)}&populate[departments]=true&populate[organizer]=true&sort=start:desc&pagination[pageSize]=${limit}`,
        { tag: "events", revalidate: 60 },
      ),
    // Events overlapping the half-open window [from, to) for the month
    // grid — multi-day spans included: start < window end AND
    // (end ?? start) >= window start ($or handles the nullable end).
    window: (fromIso: string, toIso: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[start][$lt]=${encodeURIComponent(toIso)}&filters[$or][0][end][$gte]=${encodeURIComponent(fromIso)}&filters[$or][1][end][$null]=true&filters[$or][1][start][$gte]=${encodeURIComponent(fromIso)}&populate[departments]=true&populate[organizer]=true&sort=start:asc&pagination[pageSize]=100`,
        { tag: "events", revalidate: 60 },
      ),
    one: (id: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/events?filters[id][$eq]=${encodeURIComponent(id)}&populate[departments]=true&populate[organizer]=true`,
        { tag: `event:${id}`, revalidate: 60 },
      ),
    // RSVP rows for a set of events. noCache: the response contains the
    // caller's own answer (myStatus is derived from it) — user-variable
    // data must never enter the URL-keyed fetch cache. The filter targets
    // the plain string column targetDocumentId (no relation traversal);
    // the user populate is field-limited to displayName. Guests never call
    // this (no event-rsvp.find grant — the page skips the fetch).
    // Strapi's REST maxLimit caps pageSize at 100 (see acknowledgements.ts),
    // so this walks the pagination like the ack helpers do. Hard upper
    // bound: 30 pages x 100 rows = 3000 rows, comfortably above 50 visible
    // events with full attendance while still bounding a runaway loop.
    rsvps: async (documentIds: string[]) => {
      const filters = documentIds
        .map((d, i) => `filters[targetDocumentId][$in][${i}]=${encodeURIComponent(d)}`)
        .join("&");
      const MAX_RSVP_PAGES = 30;
      const all: any[] = [];
      for (let page = 1; page <= MAX_RSVP_PAGES; page++) {
        const res = await strapi<StrapiListResponse<any>>(
          // Secondary sort on id keeps the page walk stable when many
          // rows share the same respondedAt (no skips/duplicates).
          `/api/event-rsvps?${filters}&populate[user][fields][0]=displayName&sort[0]=respondedAt:asc&sort[1]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
          { noCache: true },
        );
        all.push(...(res?.data ?? []));
        const pagination = res?.meta?.pagination;
        if (!pagination || page >= pagination.pageCount) break;
      }
      return { data: all };
    },
  },
  polls: {
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/polls?populate[departments]=true&populate[author]=true&sort=createdAt:desc&pagination[pageSize]=20",
        { tag: "polls", revalidate: 30 },
      ),
    results: (id: number) =>
      strapi<any>(`/api/polls/${id}/results`, { noCache: true }),
  },
  documents: {
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/documents?populate[file]=true&populate[departments]=true&populate[uploadedBy]=true&sort=updatedAt:desc&pagination[pageSize]=50",
        { tag: "documents", revalidate: 60 },
      ),
  },
  kudos: {
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
    list: (todayIso: string, category?: string) => {
      let url = `/api/classifieds?filters[expiresAt][$gte]=${encodeURIComponent(todayIso)}&populate[images]=true&populate[author][fields][0]=displayName&populate[author][fields][1]=email&populate[author][fields][2]=jobTitle&sort=createdAt:desc&pagination[pageSize]=100`;
      if (category) url += `&filters[category][$eq]=${encodeURIComponent(category)}`;
      return strapi<StrapiListResponse<any>>(url, { noCache: true });
    },
    // Own ads including expired ones (renew UI). The author filter is a
    // user-relation traversal — fine for every posting role (all hold
    // user.find), and guests never reach this query.
    mine: (userId: number) =>
      strapi<StrapiListResponse<any>>(
        `/api/classifieds?filters[author][id][$eq]=${userId}&populate[images]=true&sort=createdAt:desc&pagination[pageSize]=100`,
        { noCache: true },
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
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/quick-links?sort[0]=order:asc&sort[1]=label:asc&pagination[pageSize]=100",
        { noCache: true },
      ),
  },
  celebrations: () =>
    strapi<{ data: any[] }>("/api/celebrations?window=30", { noCache: true }),
};
