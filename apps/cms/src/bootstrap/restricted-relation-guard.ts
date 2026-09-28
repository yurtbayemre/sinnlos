import { hasAudienceBypass } from "../utils/announcement-audience";
import {
  RESTRICTED_RELATION_TARGETS,
  guardRestrictedRelations,
  stripRestrictedRelationsFromOutput,
  type RelationModel,
} from "../utils/restricted-relations";
import { pickContentApiQueryParams, type RouteWithQuerySchema } from "../utils/rest-query-params";

type SanitizeQuery = (
  query: Record<string, unknown>,
  schema: RelationModel,
  options?: { route?: RouteWithQuerySchema | null; [option: string]: unknown },
) => Promise<Record<string, unknown>>;

/** The slice of the Strapi instance registerRestrictedRelationGuard touches. */
export interface RestrictedRelationGuardHost {
  getModel: (uid: string) => RelationModel | undefined;
  requestContext: {
    get: () => { state?: { user?: { role?: { type?: string } | null } | null } } | undefined;
  };
  sanitizers: {
    get: (path: string) => unknown[];
    set: (path: string, value: unknown[]) => unknown;
  };
  contentAPI?: { sanitize?: { query?: SanitizeQuery } };
}

/**
 * Cuts relation side channels into visibility-filtered types (FX05, rules
 * and walk in utils/restricted-relations.ts) on EVERY content-api route:
 * core, users-permissions (/api/users, /api/users/me) and upload alike, and
 * writes as well as reads, since an update's `?populate` shapes its response.
 *
 * Query side — WHY a wrapper around `strapi.contentAPI.sanitize.query` and
 * not a sanitizer registry entry or a route policy: the registry only has
 * `content-api.input` and `content-api.output` hooks (@strapi/core 5.49 and
 * 5.55.1 services/content-api/index.js), and a route policy misses every route it
 * is not attached to. The first FX05 cut, a policy on department/team reads,
 * left /api/users?populate[department][populate][pages] and PUT
 * /api/teams/:id?populate[pages] open. Every content-api controller resolves
 * `strapi.contentAPI.sanitize.query` at call time (core-api controller,
 * users-permissions user controller, upload content-api) and hands its
 * RESULT to the service, so one wrapper covers them all. It runs on the
 * sanitized query, after validateQuery: a rewritten populate can no longer
 * turn into a validation 400 (the wildcard expansion 400'd on the private
 * createdBy/updatedBy before), and a rejected filter/sort path throws the
 * core's own `Invalid key` 400.
 *
 * Output side — a `content-api.output` sanitizer that deletes restricted
 * relations from every response entity: the backstop for a controller that
 * populates without going through sanitize.query. Appended via get()+set(),
 * never `.add` (silent no-op, see bootstrap/user-contact-sanitizer.ts).
 *
 * Root keys (final review C1-RAW-WHERE) — the same wrapper first drops
 * every root key outside the content-api allowlist
 * (utils/rest-query-params.ts). The core sanitizer keeps unknown keys, and
 * users-permissions and upload hand them to `strapi.db.query`, so a raw
 * `?where[department][pages][body]…` or `?orderBy`/`?select` skipped every
 * check above. This pick applies to EVERY caller, admin_role and editor
 * included: `where` also reaches private fields (password hash, reset
 * token) that no role may probe.
 *
 * admin_role / editor bypass the relation cut on both sides. They see every
 * wiki page anyway (wiki-visibility bypass). The role comes from the request
 * AsyncLocalStorage, as in registerUserContactSanitizer. Without a request
 * context the guard APPLIES (fail closed): nothing internal reads through
 * the content API.
 *
 * Fails loudly: if a Strapi upgrade moves `contentAPI.sanitize.query`, boot
 * throws instead of silently re-opening the side channel.
 */
export function registerRestrictedRelationGuard(strapi: RestrictedRelationGuardHost) {
  const sanitize = strapi.contentAPI?.sanitize;
  const sanitizeQuery = sanitize?.query;
  if (!sanitize || typeof sanitizeQuery !== "function") {
    throw new Error(
      "[restricted-relations] strapi.contentAPI.sanitize.query not found — refusing to boot without the FX05 guard",
    );
  }

  const options = {
    getModel: (uid: string) => strapi.getModel(uid),
    rules: RESTRICTED_RELATION_TARGETS,
  };
  const bypass = () => hasAudienceBypass(strapi.requestContext.get()?.state?.user?.role?.type);

  sanitize.query = async (query, schema, sanitizeOptions) => {
    const sanitized = pickContentApiQueryParams(
      await sanitizeQuery.call(sanitize, query, schema, sanitizeOptions),
      sanitizeOptions?.route,
    );
    if (bypass()) return sanitized;
    return guardRestrictedRelations(sanitized, schema, options);
  };

  const factory = (schema: RelationModel) => (data: unknown) =>
    bypass() ? data : stripRestrictedRelationsFromOutput(data, schema, options);
  const current = strapi.sanitizers.get("content-api.output");
  strapi.sanitizers.set("content-api.output", [...current, factory]);
}
