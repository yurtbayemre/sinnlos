import { strapi } from "@/lib/strapi";

/**
 * Fetch users from the users-permissions REST endpoint, following
 * pagination until the directory is exhausted.
 *
 * /api/users is NOT a regular content-type endpoint: it responds with a
 * plain array (no `meta.pagination`) and silently ignores the
 * `pagination[...]` query params — the plugin feeds the query straight
 * into db.query().findMany(), which only understands the top-level
 * `start`/`limit` params. We therefore page with start/limit explicitly
 * and stop at a hard safety cap so a huge directory can't stall
 * rendering.
 *
 * @param params query-string fragment (filters/populate/sort/fields),
 *               WITHOUT any pagination params.
 */
const PAGE_SIZE = 100;
const MAX_USERS = 2000;

export async function fetchAllUsers<T = any>(params = ""): Promise<T[]> {
  // Postgres returns rows in an undefined order without ORDER BY, so a
  // start/limit page walk can duplicate or skip rows across page
  // boundaries. Force a deterministic sort when the caller passed none —
  // `id` is the primary key, so it's always present and unique. The
  // users-permissions find endpoint runs the query through query-params
  // transform, which turns `sort=id:asc` into an orderBy clause.
  const hasSort = /(^|&)sort=/.test(params);
  const query = hasSort
    ? params
    : params
      ? `${params}&sort=id:asc`
      : "sort=id:asc";
  const all: T[] = [];
  for (let start = 0; start < MAX_USERS; start += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, MAX_USERS - start);
    const batch = await strapi<T[]>(
      `/api/users?${query}&start=${start}&limit=${limit}`,
      { noCache: true },
    );
    // DEMO_MODE answers unknown paths with a `{ data, meta }` object —
    // treat anything that isn't a plain array as an empty page.
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
  }
  return all;
}
