import { ALLOWED_QUERY_PARAM_KEYS } from "@strapi/utils";

/**
 * Root query keys a content-api request may hand to a service (final review
 * C1-RAW-WHERE).
 *
 * Why: Strapi's `sanitize.query` only rewrites `filters`, `sort`, `fields`
 * and `populate`. Without `api.rest.strictParams` (this CMS sets none) it
 * returns every other key of the client query verbatim (@strapi/utils
 * sanitize/index.js sanitizeQuery: cloneDeep + pick only under
 * strictParams; unchanged from 5.49 to 5.55.1). The core content types are
 * safe anyway, because the document service drops unknown root params, but
 * users-permissions and upload skip the document service: their services
 * run the sanitized query through `query-params.transform`, which keeps
 * unknown keys (`{ ...rest, ...query }`, convert-query-params.js), and hand
 * the result to `strapi.db.query(uid).findMany/findOne`. The DB layer reads
 * the raw query-builder keys `where`, `select`, `orderBy`, `groupBy` and
 * `offset` (@strapi/database query-builder.js init). On 5.49
 *   `GET /api/users?where[department][pages][body][$startsWith]=Secret`
 *   `GET /api/users?where[resetPasswordToken][$startsWith]=a1`
 * therefore reached the database with no private-field, restricted-relation
 * or FX05 check at all: a blind row-count oracle over hidden wiki bodies,
 * sensitive user fields and even password hashes and reset tokens, for
 * every role that holds `user.find` (all of them). The FX05 guard only
 * inspected `filters`, `sort` and `populate`, so it missed this.
 *
 * Since 5.55.1 the users-permissions user service applies the same pick
 * itself (`pick(ALLOWED_QUERY_PARAM_KEYS)` in fetch, fetchAll and count,
 * services/user.js), so for /api/users this pick is now defence in depth.
 * It still carries the rest: the upload service's findMany/findPage keep
 * running the raw sanitized query through `query-params.transform`
 * (@strapi/upload 5.55.1 services/upload.js), and one allowlist on every
 * content-api route does not depend on each plugin getting it right.
 *
 * What: keep exactly the keys Strapi itself keeps under strictParams — the
 * core `ALLOWED_QUERY_PARAM_KEYS` plus the query keys the route declares in
 * `request.query` (`contentAPI.addQueryParams`, @strapi/utils
 * content-api-route-params.js) — and drop everything else. The web only
 * sends filters/sort/populate/fields/pagination/start/limit/status/locale,
 * and custom controllers read their own params (e.g. `?window`, `?days`)
 * from `ctx.query`, never from the sanitized result.
 *
 * `api.rest.strictParams: true` alone would not do: the users-permissions
 * and upload controllers pass only `{ auth }` / `{ auth, route }` to
 * `sanitize.query`, never strictParams (still so in 5.55.1), so the core
 * pick never runs there.
 */

/** The slice of a Strapi route the pick depends on. */
export interface RouteWithQuerySchema {
  request?: { query?: Record<string, unknown> } | null;
}

/** Returns a copy of `query` holding only content-api query keys. */
export function pickContentApiQueryParams(
  query: Record<string, unknown>,
  route?: RouteWithQuerySchema | null,
): Record<string, unknown> {
  const allowed = new Set<string>([
    ...ALLOWED_QUERY_PARAM_KEYS,
    ...Object.keys(route?.request?.query ?? {}),
  ]);
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (allowed.has(key)) picked[key] = value;
  }
  return picked;
}
