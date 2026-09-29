/**
 * The people directory and the caller's own profile (WD01). Uncached
 * (D-DC01); the users-permissions output sanitizer strips contact fields
 * for non-staff callers (issue #10), so every answer is per-user.
 */
import { strapi, type StrapiDataResponse } from "@/lib/strapi/client";

/**
 * One page of GET /api/users. This is the users-permissions plugin route,
 * not a content-type route: it answers a PLAIN ARRAY (no `meta`) and
 * ignores `pagination[...]`; it pages with the top-level `start`/`limit`
 * (lib/users.ts walks it). `params` is the caller's query fragment
 * (fields, populate, filters, sort; code constants of the pages, e.g.
 * PEOPLE_QUERY), without pagination.
 */
export function usersPage<T>(params: string, start: number, limit: number): Promise<T[]> {
  return strapi<T[]>(`/api/users?${params}&start=${start}&limit=${limit}`);
}

/**
 * GET /api/me: the caller's own allowlisted profile (FX02, granted to every
 * role), including role and department — /api/users/me strips `role` for
 * everyone but admin_role (lib/viewer.ts). The body stays `unknown` until
 * the caller checks it (toViewer).
 */
export function me(): Promise<StrapiDataResponse<unknown>> {
  return strapi<StrapiDataResponse<unknown>>("/api/me");
}
