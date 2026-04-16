/**
 * Thin Strapi v5 fetch client used from Server Components and Server Actions.
 * The Strapi JWT (issued by the users-permissions Microsoft provider and
 * stored in the Auth.js session) is injected automatically.
 */
import { auth } from "@/auth";
import { demo } from "@/lib/demo";

const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const DEMO_MODE = process.env.DEMO_MODE === "1";

export type StrapiListResponse<T> = {
  data: T[];
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } };
};
export type StrapiEntityResponse<T> = { data: T };

export interface FetchOptions extends RequestInit {
  /** Next.js cache tag for revalidation. */
  tag?: string;
  /** ISR revalidation interval in seconds. */
  revalidate?: number;
  /** Override the strapi JWT (e.g. during login callback). */
  tokenOverride?: string;
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

  const res = await fetch(`${STRAPI_URL}${path}`, {
    ...opts,
    headers,
    next: {
      revalidate: opts.revalidate,
      tags: opts.tag ? [opts.tag] : undefined,
    },
  });

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
    spaces: () =>
      strapi<StrapiListResponse<any>>(
        "/api/wiki-spaces?populate[department]=true&populate[team]=true&sort=name:asc",
        { tag: "wiki-spaces", revalidate: 60 },
      ),
    space: (slug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/wiki-spaces?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[pages][populate][author]=true`,
        { tag: `wiki-space:${slug}`, revalidate: 60 },
      ),
    page: (spaceSlug: string, pageSlug: string) =>
      strapi<StrapiListResponse<any>>(
        `/api/wiki-pages?filters[space][slug][$eq]=${encodeURIComponent(spaceSlug)}&filters[slug][$eq]=${encodeURIComponent(pageSlug)}&populate[author]=true&populate[lastEditor]=true&populate[space]=true&populate[revisions][populate][editor]=true`,
        { tag: `wiki-page:${spaceSlug}:${pageSlug}`, revalidate: 30 },
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
