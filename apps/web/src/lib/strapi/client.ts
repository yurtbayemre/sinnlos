/**
 * The Strapi transport (WD01): strapi(), its init type, the list envelope
 * and the error it throws. Used from Server Components, Server Actions and
 * Route Handlers. The caller's Strapi JWT (issued by the cms's Entra
 * exchange or local sign-in, read through getStrapiToken() in
 * lib/session.ts) is injected automatically. The typed reads live in
 * lib/api/*.ts; lib/strapi.ts is the facade the rest of the web imports.
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
 * apps/web/eslint.config.mjs, strapi.test.ts and the request snapshot
 * (strapi-urls.test.ts). A server-side cache may only come back under the
 * decision's re-entry rule (§10).
 */
import { redirect } from "next/navigation";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { demo } from "@/lib/demo";
import { getStrapiToken } from "@/lib/session";
import { StrapiError } from "@/lib/strapi-error";

export { StrapiError, parseStrapiError, type StrapiErrorInfo } from "@/lib/strapi-error";

/** `meta.pagination` of a Strapi list (page-based pagination). */
export interface StrapiPagination {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

/** A content-type `find` answer: rows and their pagination. */
export type StrapiListResponse<T> = {
  data: T[];
  meta: { pagination: StrapiPagination };
};

/** A single-object envelope (`/api/me`, custom endpoints). */
export type StrapiDataResponse<T> = { data: T };

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
  // wrappers rethrow it via unstable_rethrow (see lib/safe-fetch.ts). A
  // session that ended before the request (the Strapi JWT's exp passed) is
  // sent to the same page by proxy.ts, for page loads and actions alike.
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
