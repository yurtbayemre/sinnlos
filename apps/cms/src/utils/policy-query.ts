/**
 * Returns the REAL, mutable query object that Strapi's core controllers
 * will read, from inside a policy handler.
 *
 * Why this exists — the policy-context no-op trap:
 *   Strapi builds the `policyContext` via
 *   `createPolicyContext('koa', ctx)` → `Object.assign({ is, type }, ctx)`
 *   (see @strapi/utils 5.49 `dist/policy.js`). `Object.assign` only copies
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
 * for both populated and empty querystrings).
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
 *   The core controllers run `sanitizeQuery` (@strapi/utils 5.49
 *   `dist/sanitize/sanitizers.js`, `defaultSanitizeFilters`) over the
 *   request filters AFTER our policy injected them. Its last visitor
 *   removes "empty plain objects and empty arrays" as operands — so
 *   `{ id: { $in: [] } }` loses the `$in` key and degrades to `{ id: {} }`,
 *   which is no constraint at all. A user who may see NOTHING would
 *   suddenly see EVERYTHING (fail-open). Verified via node repro against
 *   the installed @strapi/utils 5.49:
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
