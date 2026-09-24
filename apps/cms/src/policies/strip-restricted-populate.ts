import { hasAudienceBypass } from "../utils/announcement-audience";
import { getMutableQuery } from "../utils/policy-query";
import { stripRestrictedPopulate } from "../utils/restricted-populate";
import type { ModelSchema } from "../utils/sanitize-user-contact";

/**
 * Closes populate side channels into visibility-filtered types (FX05).
 *
 * department and team are readable without a visibility filter, but own the
 * inverse relation `pages` into wiki-page: `GET /api/departments?populate
 * [pages]=true` (or `populate=*`, `populate[teams][populate][pages]`, ...)
 * returned the pages of every wiki space — past wiki-visibility, which only
 * narrows the ROOT query of the wiki routes. This policy rewrites the
 * client's `populate` so that no path reaches a `config.targets` type; the
 * shape handling (objects, strings, arrays, dotted paths, every `*` form)
 * lives in utils/restricted-populate.ts.
 *
 * Config: `{ uid, targets }` — `uid` is the route's own content type (the
 * root model of the populate walk), `targets` the uids no populate path may
 * reach. A route without a resolvable config fails CLOSED (403), because a
 * silently skipped walk would re-open the channel. routes.matrix.test.ts
 * pins the config for every detected side channel.
 *
 * admin_role / editor bypass: they see every wiki page anyway
 * (wiki-visibility bypass). Everyone else keeps all other populate paths.
 *
 * Writes through getMutableQuery — `policyContext.query` is a throw-away
 * copy (§5.14). Returns strict booleans (undefined counts as PASS).
 */

interface StripPopulateConfig {
  uid?: string;
  targets?: string[];
}

interface PolicyContext {
  state?: { user?: { role?: { type?: string } | null } | null };
  request?: { query?: Record<string, unknown> };
}

interface PolicyDeps {
  strapi: { getModel: (uid: string) => ModelSchema | undefined };
}

export default (
  policyContext: PolicyContext,
  config: StripPopulateConfig | undefined,
  { strapi }: PolicyDeps,
): boolean => {
  const uid = config?.uid;
  const targets = config?.targets;
  if (!uid || !Array.isArray(targets) || targets.length === 0) return false;
  if (!strapi.getModel(uid)) return false;

  if (hasAudienceBypass(policyContext.state?.user?.role?.type)) return true;

  const query = getMutableQuery(policyContext);
  if (query.populate === undefined) return true;

  query.populate = stripRestrictedPopulate(query.populate, uid, {
    getModel: (modelUid: string) => strapi.getModel(modelUid),
    restrictedTargets: new Set(targets),
  });
  return true;
};
