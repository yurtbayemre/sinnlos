/**
 * Thin Strapi v5 fetch client used from Server Components and Server Actions.
 * The Strapi JWT (issued by the users-permissions Microsoft provider and
 * stored in the Auth.js session) is injected automatically.
 */
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
  const token = opts.tokenOverride ?? (session as any)?.strapiJwt ?? null;

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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strapi ${res.status} ${res.statusText}: ${body}`);
  }

  return (await res.json()) as T;
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
  announcements: {
    list: () =>
      strapi<StrapiListResponse<any>>(
        "/api/announcements?populate[author][fields][0]=username&populate[author][fields][1]=email&populate[author][fields][2]=displayName&populate[author][fields][3]=jobTitle&sort=pinned:desc,createdAt:desc&pagination[pageSize]=10",
        { tag: "announcements", revalidate: 30 },
      ),
  },
};
