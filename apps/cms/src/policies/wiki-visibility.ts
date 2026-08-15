import { getMutableQuery, restrictiveIdFilter } from "../utils/policy-query";
import { loadUserScope, visibleWikiSpaceIds } from "../utils/visible-ids";

/**
 * Enforces wiki-space visibility on reads of wiki-space, wiki-page and
 * wiki-revision. wiki-page / wiki-revision have no visibility of their own —
 * they inherit it from their owning space (page.space, revision.page.space).
 *
 * Visibility rules (see `visibleWikiSpaceIds`):
 *   - public     → everyone (incl. anonymous)
 *   - role       → authenticated users whose role is in space.allowedRoles
 *   - department → authenticated users whose department is space.department
 *   - team       → authenticated users one of whose teams is space.team
 *
 * admin_role / editor bypass the filter entirely.
 *
 * HOW IT WORKS — id-based filtering, no relation traversal:
 *   This policy used to write a relation-traversing `$or` filter onto
 *   `policyContext.query`, which was a silent no-op (Koa's `query` is a
 *   prototype getter that `createPolicyContext`'s `Object.assign` never
 *   copies) — so wiki visibility was never actually enforced at the API.
 *   Redirecting that same filter to the REAL request query would 400 every
 *   read, because the narrow intranet read scopes (guest has no
 *   department/team/role/wiki-revision `.find`) make Strapi's
 *   `validateQuery` → `throwRestrictedRelations` reject any filter that
 *   reaches through those relations, and the wiki-page / wiki-revision
 *   schemas have no `visibility` / `allowedRoles` attributes to filter on.
 *
 *   Instead we resolve the set of visible primary-key ids SERVER-SIDE via
 *   `strapi.db.query` (which bypasses both permission gating AND
 *   `throwRestrictedRelations`), then inject a single non-relational
 *   `{ id: { $in: [...] } }` clause into the real request query. `id` is a
 *   plain attribute on every one of the three content types, so the filter
 *   validates for EVERY role and traverses nothing — no 400.
 *
 * The clause is `$and`-wrapped with any incoming client filter so a
 * caller-supplied filter can only narrow the result set, never widen it
 * past what they are allowed to see. An empty id list must NOT become
 * `{ id: { $in: [] } }` — sanitizeQuery strips empty array operands, which
 * would drop the filter entirely (fail-open, sees EVERYTHING);
 * `restrictiveIdFilter` injects a scalar `{ id: { $eq: -1 } }` instead.
 *
 * The applicable content-type level is passed per route via the policy
 * config: `{ name: "global::wiki-visibility", config: { level: "space" } }`.
 */

type WikiLevel = "space" | "page" | "revision";

export default async (
  policyContext: any,
  config: { level?: WikiLevel } | undefined,
  { strapi }: any,
) => {
  const user = policyContext.state?.user;

  // admin_role / editor see everything, no filter needed.
  if (user && ["admin_role", "editor"].includes(user.role?.type)) return true;

  const level: WikiLevel = config?.level ?? "space";

  const scope = user ? await loadUserScope(strapi, user.id) : null;
  const spaceIds = await visibleWikiSpaceIds(strapi, scope);

  let idList: number[];
  if (level === "space") {
    idList = spaceIds;
  } else if (spaceIds.length === 0) {
    // No visible space → no visible page/revision either. Skip the join.
    idList = [];
  } else if (level === "page") {
    const pages: { id: number }[] = await strapi.db
      .query("api::wiki-page.wiki-page")
      .findMany({ where: { space: { id: { $in: spaceIds } } }, select: ["id"] });
    idList = pages.map((p) => p.id);
  } else {
    // revision → visible when its page's space is visible.
    const revisions: { id: number }[] = await strapi.db
      .query("api::wiki-revision.wiki-revision")
      .findMany({
        where: { page: { space: { id: { $in: spaceIds } } } },
        select: ["id"],
      });
    idList = revisions.map((r) => r.id);
  }

  const query = getMutableQuery(policyContext);
  const idFilter = restrictiveIdFilter(idList);
  query.filters = query.filters ? { $and: [query.filters, idFilter] } : idFilter;

  return true;
};
