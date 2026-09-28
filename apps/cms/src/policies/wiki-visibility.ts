import { MODERATORS } from "../bootstrap/roles";
import { rowIds, visibleIdsPolicy, type VisibleIdsInput } from "../utils/policy-factories";
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
 * admin_role / editor bypass the filter entirely (and keep draft reads).
 *
 * HOW IT WORKS — id-based filtering, no relation traversal
 * (visibleIdsPolicy, utils/policy-factories.ts):
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
 *   Instead the visible primary-key ids are resolved SERVER-SIDE via
 *   `strapi.db.query` and injected as a single non-relational
 *   `{ id: { $in: [...] } }` clause, $and-composed with the client filter;
 *   an empty list becomes `{ id: { $eq: -1 } }` (fail-closed).
 *
 * The applicable content-type level is passed per route via the policy
 * config: `{ name: "global::wiki-visibility", config: { level: "space" } }`.
 *
 * Draft & publish note: space, page and revision are all draftAndPublish
 * and the ids come from `strapi.db.query`, so the injected list spans BOTH
 * publication states; the status is pinned to "published" (`?status=draft`
 * trap, `forcePublishedStatus`).
 */

type WikiLevel = "space" | "page" | "revision";
type WikiConfig = { level?: WikiLevel } | undefined;

const UIDS: Record<WikiLevel, string> = {
  space: "api::wiki-space.wiki-space",
  page: "api::wiki-page.wiki-page",
  revision: "api::wiki-revision.wiki-revision",
};

/** No config reads spaces; an unknown level reads revisions, as before the factory. */
const levelOf = (config: WikiConfig): WikiLevel => {
  const level = config?.level ?? "space";
  return level === "space" || level === "page" ? level : "revision";
};

async function visibleWikiIds({
  strapi,
  user,
  config,
  uid,
}: VisibleIdsInput<WikiConfig>): Promise<number[]> {
  const scope = user ? await loadUserScope(strapi, user.id) : null;
  const spaceIds = await visibleWikiSpaceIds(strapi, scope);
  const level = levelOf(config);
  if (level === "space") return spaceIds;
  // No visible space → no visible page/revision either. Skip the join.
  if (spaceIds.length === 0) return [];
  const where =
    level === "page"
      ? { space: { id: { $in: spaceIds } } }
      : // revision → visible when its page's space is visible.
        { page: { space: { id: { $in: spaceIds } } } };
  return rowIds(await strapi.db.query(uid).findMany({ where, select: ["id"] }));
}

export default visibleIdsPolicy<WikiConfig>({
  uid: (config) => UIDS[levelOf(config)],
  bypass: MODERATORS,
  anonymous: "filter",
  pinPublished: true,
  loadVisibleIds: visibleWikiIds,
});
