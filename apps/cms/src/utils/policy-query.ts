import { errors } from "@strapi/utils";

/**
 * Returns the REAL, mutable query object that Strapi's core controllers
 * will read, from inside a policy handler.
 *
 * Why this exists — the policy-context no-op trap:
 *   Strapi builds the `policyContext` via
 *   `createPolicyContext('koa', ctx)` → `Object.assign({ is, type }, ctx)`
 *   (see @strapi/utils `dist/policy.js`, same in 5.49 and 5.55.1).
 *   `Object.assign` only copies
 *   OWN enumerable properties. Koa exposes `ctx.query` as a *prototype
 *   getter* (delegated to `request.query`), so it is NOT copied onto the
 *   plain object. Assigning `policyContext.query = {...}` therefore creates
 *   a throw-away own property that the controller never reads — a silent
 *   no-op. The core controllers read `ctx.query` (→ `ctx.request.query`),
 *   never `policyContext.query`.
 *
 *   `ctx.request`, by contrast, IS an own property of the Koa context and
 *   is copied by reference, so `policyContext.request === ctx.request`.
 *   Koa's `request.query` getter lazily parses the querystring and caches
 *   the resulting object per querystring, so the object it returns is
 *   stable for the life of the request and safe to mutate in place.
 *   Mutating `policyContext.request.query.filters` is therefore observed by
 *   the controller's `validateQuery` / `sanitizeQuery` (both read
 *   `ctx.query`).
 *
 * Verified empirically against @strapi/utils 5.49 + koa 2.16 via node repro
 * (mutating `policyContext.query` → ctx.query.filters === undefined;
 * mutating `policyContext.request.query` → ctx.query.filters reflects it,
 * for both populated and empty querystrings); repeated on @strapi/utils
 * 5.55.1 + koa 2.16.4 with the same result.
 */
export function getMutableQuery(policyContext: any): Record<string, any> {
  const request = policyContext?.request;
  if (request && typeof request === "object") {
    // Koa's getter always returns an object; the `??` fallback only guards
    // non-Koa callers (e.g. unit tests) that pass a bare request stub.
    return request.query ?? (request.query = {});
  }
  // Last-resort fallback for non-Koa policy contexts.
  return policyContext.query ?? (policyContext.query = {});
}

/**
 * Builds the `{ id: ... }` filter clause the id-based visibility policies
 * inject for a resolved list of visible primary-key ids.
 *
 * Why the empty list needs special treatment — the sanitize fail-open trap:
 *   The core controllers run `sanitizeQuery` (@strapi/utils
 *   `dist/sanitize/sanitizers.js`, `defaultSanitizeFilters`) over the
 *   request filters AFTER our policy injected them. Its last visitor
 *   removes "empty plain objects and empty arrays" as operands — so
 *   `{ id: { $in: [] } }` loses the `$in` key and degrades to `{ id: {} }`,
 *   which is no constraint at all. A user who may see NOTHING would
 *   suddenly see EVERYTHING (fail-open). Verified via node repro against
 *   @strapi/utils 5.49 and again 5.55.1:
 *     { id: { $in: [] } }  → sanitized to { id: {} }
 *     { id: { $eq: -1 } }  → survives unchanged
 *
 *   We therefore inject a SCALAR operand for the empty case:
 *   `{ id: { $eq: -1 } }` is sanitize-proof (scalar, non-empty) and can
 *   never match — Strapi primary keys are positive integers, so -1 does
 *   not exist. Non-empty lists keep the regular `$in`.
 */
export function restrictiveIdFilter(idList: number[]): Record<string, any> {
  return idList.length > 0 ? { id: { $in: idList } } : { id: { $eq: -1 } };
}

/**
 * Adds a policy's clause to the query's filters so that a client filter can
 * only NARROW the result (PL01): `{ $and: [clientFilters, clause] }`, or the
 * clause alone when the client sent none.
 *
 * Never a spread merge: in `{ ...a, ...b }` a key of one side REPLACES the
 * same key of the other (`id`, `user`, `$and`, `$or`), so depending on the
 * order either the client's condition is lost or the client overwrites the
 * policy's clause and widens the result. The client filter stays one opaque
 * operand; Strapi validates and sanitizes the whole tree afterwards.
 *
 * `query` must be the REAL request query (getMutableQuery above); a falsy
 * client value (absent, null, "") counts as none, so the clause never ends
 * up next to an empty operand in an `$and`.
 */
export function narrowFilters(
  query: Record<string, unknown>,
  clause: Record<string, unknown>,
): void {
  assertFiltersShape(query.filters);
  query.filters = query.filters ? { $and: [query.filters, clause] } : clause;
}

/**
 * Refuses client filters that are neither an object nor an array with a
 * 400: a scalar wrapped in `$and` (narrowFilters, or the Document Service
 * narrowing below) bypasses Strapi's root shape check and fails as a
 * database 500 ("Where must be an array or an object").
 */
export function assertFiltersShape(filters: unknown): void {
  if (filters && typeof filters !== "object") {
    throw new errors.ValidationError("The filters parameter must be an object or an array");
  }
}

/**
 * The database a one-parameter list is written for: the dialect and the
 * knex instance the query engine runs on (`strapi.db.connection`).
 */
export interface OneParamHost {
  db: {
    dialect?: { client?: unknown };
    connection: { raw(sql: string, bindings: unknown[]): unknown };
  };
}

/**
 * An `$in` operand that carries a whole list as ONE bound parameter (#175,
 * v0.33): `{ id: { $in: oneParamIn(strapi, ids, "int") } }`. A plain array
 * binds one parameter per value, and a statement may bind at most 65535
 * (Postgres, an int16 in the wire protocol) or 32766 (SQLite); a read
 * policy whose list grew past that used to answer nothing. This one does
 * not grow with the list:
 *
 *   - Postgres: `select unnest(?::int[])` / `?::text[]`, the list bound as
 *     one array (pg serialises a JS array as an array literal);
 *   - SQLite (and any other dialect): `select value from json_each(?)`,
 *     the list bound as one JSON text.
 *
 * The query engine keeps a knex raw as the operand (@strapi/database 5.59
 * `query/helpers/where.js` `$in`: `isKnexQuery(value) ? value : [...]`), so
 * this works in a `db.query` where clause and in a Document Service
 * `params.filters` (createVisibilityNarrowing below), never in a REST
 * query: the content API's filter walkers would recurse into the knex
 * object. An empty list matches nothing, no special case.
 */
export function oneParamIn(
  strapi: OneParamHost,
  values: readonly (number | string)[],
  kind: "int" | "text",
): unknown {
  if (strapi.db.dialect?.client === "postgres") {
    return strapi.db.connection.raw(`select unnest(?::${kind}[])`, [[...values]]);
  }
  return strapi.db.connection.raw("select value from json_each(?)", [JSON.stringify(values)]);
}

/** Where a read policy leaves its clause for the Document Service: on ctx.state. */
const VISIBILITY = Symbol.for("sinnlos.visibility");

/** The request context as `strapi.requestContext.get()` returns it: the Koa context. */
interface RequestState {
  state?: Record<PropertyKey, unknown>;
}

/** The slice of `strapi` that hands out the current request. */
export interface RequestContextHost {
  requestContext?: { get(): unknown } | null;
}

function currentState(strapi: RequestContextHost): Record<PropertyKey, unknown> | null {
  const request =
    typeof strapi.requestContext?.get === "function" ? strapi.requestContext.get() : undefined;
  const state = (request as RequestState | undefined)?.state;
  return typeof state === "object" && state !== null ? state : null;
}

/**
 * Whether a read policy can hand a clause to the Document Service in this
 * request: `strapi.requestContext` (Strapi's AsyncLocalStorage, one store
 * per request) holds the very context the policy runs in. Without it the
 * clause would never reach the read, so the policy refuses (false) instead
 * of answering unfiltered.
 */
export function canNarrow(strapi: RequestContextHost, policyState: unknown): boolean {
  const state = currentState(strapi);
  return state !== null && state === policyState;
}

/**
 * Leaves `clause` for every Document Service read of `uid` in this request
 * (findMany, findOne, findFirst, count: the list AND its pagination count),
 * ANDed into its `params.filters` by createVisibilityNarrowing. For clauses
 * whose operand cannot go through the REST query (a oneParamIn list).
 * Returns false when there is no request context (canNarrow); the caller
 * then refuses.
 */
export function narrowReads(
  strapi: RequestContextHost,
  policyState: unknown,
  uid: string,
  clause: Record<string, unknown>,
): boolean {
  if (!canNarrow(strapi, policyState)) return false;
  const state = currentState(strapi) as Record<PropertyKey, unknown>;
  const byUid = (state[VISIBILITY] ??= new Map()) as Map<string, Record<string, unknown>[]>;
  byUid.set(uid, [...(byUid.get(uid) ?? []), clause]);
  return true;
}

/** The Document Service reads a stored clause narrows. */
const NARROWED_READS = new Set(["findMany", "findOne", "findFirst", "count"]);

/** A Document Service middleware as @strapi/core runs them (context, next). */
export type NarrowingMiddleware = (
  context: { uid?: string; action?: string; params?: unknown },
  next: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * The Document Service middleware that applies what narrowReads stored
 * (#175, v0.33): for a read of a uid with stored clauses, the clauses are
 * ANDed into `params.filters`, after the content API validated and
 * sanitized the client's part, so a client filter still only narrows.
 * `params.filters`, never `params.where`: the Document Service drops an
 * unknown `where` key (document-service/params.js), which would leave the
 * clause unapplied.
 *
 * A read outside a request, or of a uid nobody stored a clause for, is
 * untouched: cron jobs, lifecycles, the policies' own loaders (they run
 * before the clause is stored, through db.query anyway). Populate and
 * relation joins do not go through the Document Service and keep the
 * relation guards they have (utils/restricted-relations.ts).
 */
export function createVisibilityNarrowing(strapi: RequestContextHost): NarrowingMiddleware {
  return async (context, next) => {
    if (!context.uid || !NARROWED_READS.has(String(context.action))) return next();
    const stored = (currentState(strapi)?.[VISIBILITY] as Map<string, unknown[]> | undefined)?.get(
      context.uid,
    );
    if (!stored?.length) return next();
    const params = (context.params ?? {}) as Record<string, unknown>;
    // Never narrow by skipping a filter we cannot wrap: refuse it (fail closed).
    assertFiltersShape(params.filters);
    const clauses = params.filters ? [params.filters, ...stored] : stored;
    context.params = { ...params, filters: clauses.length === 1 ? clauses[0] : { $and: clauses } };
    return next();
  };
}

/**
 * Pins a read query to PUBLISHED rows for the content types that use
 * draft & publish.
 *
 * Why the id filter alone is not enough — the `?status=draft` trap:
 *   The id-based visibility policies resolve their id list via
 *   `strapi.db.query`, which returns draft AND published rows, so the
 *   injected `{ id: { $in: [...] } }` is a superset spanning BOTH
 *   publication states. Which of them the caller actually gets is decided
 *   by the `status` query param — and that param is client-supplied:
 *     - `validateQuery` accepts it (`status` is in
 *       `ALLOWED_QUERY_PARAM_KEYS`, @strapi/utils
 *       `content-api-constants.js`),
 *     - `sanitizeQuery` only rewrites `filters`/`sort`/`fields`/`populate`
 *       and passes `status` through untouched,
 *     - the core service merges it OVER its own default:
 *       `getFetchParams` = `{ status: 'published', ...params }`
 *       (@strapi/core `core-api/service/core-service.js`), and
 *     - the document service turns `status: 'draft'` into
 *       `lookup.publishedAt = { $null: true }`
 *       (`services/document-service/draft-and-publish.js`).
 *   (All four files are unchanged from 5.49 to 5.55.1.)
 *   So EVERY role holding `<type>.find` could read unpublished drafts of
 *   the rows it may see by appending `?status=draft` — verified against
 *   5.49 and again 5.55.1: validateQuery ACCEPTS the param and
 *   sanitizeQuery returns it verbatim. Writing the param server-side after the
 *   admin/editor bypass closes that: our value is what sanitizeQuery sees,
 *   and it overrides whatever the client sent.
 *
 * `publicationState` is the Strapi v4 spelling of the same switch. It is
 * inert in v5 (no occurrence anywhere in @strapi/core, @strapi/utils or
 * @strapi/database 5.49 or 5.55.1), and the core does not strip it: this CMS sets no
 * `api.rest.strictParams`, so `sanitizeQuery` keeps unknown keys. The
 * sanitize.query wrapper in bootstrap/restricted-relation-guard.ts now
 * drops every non-REST root key (utils/rest-query-params.ts); deleting it
 * here as well keeps a future back-compat shim (or a plugin honouring the
 * legacy name) from re-opening the hole should that pick ever change.
 *
 * `publicationFilter` (and its deprecated boolean form `hasPublishedVersion`)
 * are live content-api keys (`SHARED_QUERY_PARAM_KEYS`, @strapi/utils
 * `content-api-constants.js`, in 5.49 and 5.55.1), so the rest-query-params
 * pick keeps them. The document service parses
 * them (`transform/query.js`) and merges a publication-cohort condition
 * into `filters` under the current status, nested populate sub-queries
 * included. Rows stay published, but the cohort reveals which published
 * documents have pending unpublished edits, which is editorial state that
 * only admin_role / editor should see. Both keys are therefore dropped
 * here, after the bypass, just like `status` is pinned.
 *
 * Where it matters: on a draftAndPublish type the pin selects the ROOT
 * rows. On a type without draft & publish (department and team since
 * decision 05, both single-row) the document service ignores `status` for
 * the root rows (`statusToLookup` returns early,
 * `services/document-service/draft-and-publish.js:50-53`), but the REST
 * query layer still applies it to every POPULATED draft & publish relation
 * (@strapi/utils 5.55.1 `convert-query-params.js:515-528`, `convertStatusParams`
 * filters each populated model that has draft & publish). So a client
 * `?status=draft&populate[...]` reaches draft rows through a non-D&P root
 * too; `published-only` keeps the pin on department/team for exactly that.
 */
export function forcePublishedStatus(query: Record<string, any>): void {
  query.status = "published";
  delete query.publicationState;
  delete query.publicationFilter;
  delete query.hasPublishedVersion;
}
