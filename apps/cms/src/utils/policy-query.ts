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
