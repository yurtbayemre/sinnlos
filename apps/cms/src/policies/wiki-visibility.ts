/**
 * Filters wiki-space / wiki-page / wiki-revision reads based on the
 * caller's role, department and team membership.
 *
 * Rules:
 *   - public           → everyone (incl. authenticated members)
 *   - role             → only users whose role is in `allowedRoles`
 *   - department       → only users belonging to `space.department`
 *   - team             → only users in `space.team.members` or the lead
 *
 * Admins and editors always pass.
 *
 * KNOWN OPEN ISSUE (do NOT "fix" by switching to the real request query):
 *   This policy currently writes to `policyContext.query`, which is a
 *   silent no-op (Koa's `query` is a prototype getter that
 *   createPolicyContext's Object.assign never copies) — so it has never
 *   actually filtered. Redirecting it to the real request query (as done
 *   for notification/poll-vote-visibility) would break ALL wiki reads with
 *   a 400, for two independently-verified reasons:
 *     1. The filter shape mixes wiki-space attributes (`visibility`,
 *        `allowedRoles`) at the top level, but this policy also guards the
 *        wiki-page and wiki-revision routes, whose schemas have no such
 *        attributes → validateQuery throws "Invalid key visibility". Even
 *        for wiki-space the `{ space: ... }` clause is invalid (wiki-space
 *        has no `space` attribute). A correct fix needs per-content-type
 *        filter shapes.
 *     2. Filtering on `allowedRoles` requires the caller to hold
 *        `plugin::users-permissions.role.find`, which NO intranet role is
 *        granted; `department`/`team`/`space` clauses likewise require
 *        those targets' `.find` scopes. validateQuery runs
 *        throwRestrictedRelations on filters, so the filter 400s.
 *   Reactivating this needs a redesign (correct per-type filters + granting
 *   the referenced relations' find scopes). Left as-is (status quo: no
 *   API-level wiki visibility filtering) to avoid a 400 app. Verified via
 *   node repro against @strapi/utils 5.49.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;

  // NOTE: writing to `policyContext.query` is intentionally a no-op today —
  // see the KNOWN OPEN ISSUE above before changing this to the real query.
  const query = policyContext.query ?? (policyContext.query = {});
  query.filters = query.filters ?? {};

  if (!user) {
    query.filters = {
      ...query.filters,
      $or: [{ visibility: "public" }, { space: { visibility: "public" } }],
    };
    return true;
  }

  if (["admin_role", "editor"].includes(user.role?.type)) return true;

  const meFull = await strapi.db.query("plugin::users-permissions.user").findOne({
    where: { id: user.id },
    populate: { department: true, teams: true, role: true },
  });
  const teamIds = (meFull?.teams ?? []).map((t: { id: number }) => t.id);
  const departmentId = meFull?.department?.id;
  const roleId = meFull?.role?.id;

  const visibilityClauses: any[] = [
    { visibility: "public" },
    {
      visibility: "role",
      allowedRoles: { id: { $in: roleId ? [roleId] : [] } },
    },
  ];
  if (departmentId) {
    visibilityClauses.push({
      visibility: "department",
      department: { id: departmentId },
    });
  }
  if (teamIds.length > 0) {
    visibilityClauses.push({ visibility: "team", team: { id: { $in: teamIds } } });
  }

  query.filters = {
    ...query.filters,
    $or: [
      ...visibilityClauses,
      { space: { $or: visibilityClauses } },
    ],
  };

  return true;
};
