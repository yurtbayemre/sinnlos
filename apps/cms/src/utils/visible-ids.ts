/**
 * Server-side visibility resolution for wiki spaces, used by the
 * wiki-visibility policy. (document-visibility only needs the caller's
 * department and resolves that inline, so it does not use this helper.)
 *
 * WHY server-side ID computation instead of a REST filter that traverses
 * relations:
 *   The intranet roles are read-scoped narrowly. `guest`, for example,
 *   only holds find/findOne on document, wiki-space and wiki-page — NOT on
 *   department, team, role or wiki-revision. Strapi's core controllers run
 *   `validateQuery` → `throwRestrictedRelations` over the REQUEST filters
 *   BEFORE sanitize, so ANY REST filter that reaches through
 *   `allowedRoles` / `department` / `team` / `space` would 400 for every
 *   role lacking that relation's `.find` scope (guest, and partly member).
 *
 *   `strapi.db.query(...)` runs at the database layer: it bypasses BOTH
 *   the users-permissions gating AND `throwRestrictedRelations`. So we
 *   resolve the set of visible primary-key `id`s HERE, in the policy, by
 *   loading the (small) space set with its visibility relations populated
 *   and deciding membership in plain JS. The policy then injects only a
 *   non-relational `{ id: { $in: [...] } }` filter into the REST query —
 *   which validates for every role and traverses nothing.
 *
 * Draft & publish note: `strapi.db.query` returns ALL rows (draft AND
 * published) regardless of publication state. That is intentional here —
 * the injected `id $in` list is a superset covering both the draft and
 * published rows of every visible space, and the core controller still
 * applies its own status filter on top. Extra ids in the list never widen
 * what the controller returns.
 */

export interface UserScope {
  roleId?: number;
  departmentId?: number;
  teamIds: number[];
}

interface SpaceRow {
  id: number;
  visibility: "public" | "role" | "department" | "team";
  allowedRoles?: { id: number }[];
  department?: { id: number } | null;
  team?: { id: number } | null;
}

/**
 * Load the caller's role / department / team membership from the DB.
 * `policyContext.state.user` carries the role type (used for the
 * admin/editor bypass) but not reliably the department/team relations, so
 * we resolve them explicitly — via `strapi.db.query`, which needs no
 * relation `.find` scope.
 */
export async function loadUserScope(strapi: any, userId: number): Promise<UserScope> {
  const meFull = await strapi.db.query("plugin::users-permissions.user").findOne({
    where: { id: userId },
    populate: { department: true, teams: true, role: true },
  });
  return {
    roleId: meFull?.role?.id,
    departmentId: meFull?.department?.id,
    teamIds: (meFull?.teams ?? []).map((t: { id: number }) => t.id),
  };
}

/** Decide whether a single space is visible to the given scope. */
function isSpaceVisible(space: SpaceRow, scope: UserScope | null): boolean {
  switch (space.visibility) {
    case "public":
      return true;
    case "role":
      return (
        scope?.roleId != null &&
        (space.allowedRoles ?? []).some((r) => r.id === scope.roleId)
      );
    case "department":
      return scope?.departmentId != null && space.department?.id === scope.departmentId;
    case "team":
      return (
        scope != null &&
        space.team?.id != null &&
        scope.teamIds.includes(space.team.id)
      );
    default:
      return false;
  }
}

/**
 * Resolve the primary-key ids of every wiki-space visible to `scope`
 * (pass `null` for anonymous callers → only `public` spaces).
 *
 * Visibility rules:
 *   - public     → everyone (incl. anonymous)
 *   - role       → authenticated users whose role is in `allowedRoles`
 *   - department → authenticated users whose department is `space.department`
 *   - team       → authenticated users one of whose teams is `space.team`
 */
export async function visibleWikiSpaceIds(
  strapi: any,
  scope: UserScope | null,
): Promise<number[]> {
  const spaces: SpaceRow[] = await strapi.db.query("api::wiki-space.wiki-space").findMany({
    select: ["id", "visibility"],
    populate: {
      allowedRoles: { select: ["id"] },
      department: { select: ["id"] },
      team: { select: ["id"] },
    },
  });
  return spaces.filter((s) => isSpaceVisible(s, scope)).map((s) => s.id);
}
