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

export interface AllUsersResult<T> {
  users: T[];
  /**
   * `true` when the walk stopped at the `MAX_USERS` safety cap while the
   * last page was still full — i.e. more rows may exist that we did NOT
   * fetch, so `users` is INCOMPLETE and callers must fail closed instead of
   * treating it as the whole directory (mirrors `walkAllPages`, issue #14).
   */
  truncated: boolean;
}

export async function fetchAllUsers<T = any>(params = ""): Promise<AllUsersResult<T>> {
  // Postgres returns rows in an undefined order without ORDER BY, so a
  // start/limit page walk can duplicate or skip rows across page
  // boundaries. Force a deterministic sort when the caller passed none —
  // `id` is the primary key, so it's always present and unique. The
  // users-permissions find endpoint runs the query through query-params
  // transform, which turns `sort=id:asc` into an orderBy clause.
  const hasSort = /(^|&)sort=/.test(params);
  const query = hasSort ? params : params ? `${params}&sort=id:asc` : "sort=id:asc";
  const users: T[] = [];
  let truncated = false;
  for (let start = 0; start < MAX_USERS; start += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, MAX_USERS - start);
    const batch = await strapi<T[]>(`/api/users?${query}&start=${start}&limit=${limit}`, {
      noCache: true,
    });
    // DEMO_MODE answers unknown paths with a `{ data, meta }` object —
    // treat anything that isn't a plain array as an empty page.
    if (!Array.isArray(batch) || batch.length === 0) break;
    users.push(...batch);
    // A short page is the natural end of the directory: no more rows exist.
    if (batch.length < limit) break;
    // A FULL page that lands exactly on the safety cap means the directory
    // was not exhausted naturally — potentially more rows exist past
    // MAX_USERS that we deliberately won't fetch. Flag the result as
    // incomplete so the ack report fails closed instead of undercounting
    // its target audience into a false-green compliance rate (#14).
    if (start + limit >= MAX_USERS) {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    console.warn(
      `[list-cap] user directory hit the ${MAX_USERS}-row safety cap — list is INCOMPLETE`,
    );
  }
  return { users, truncated };
}
