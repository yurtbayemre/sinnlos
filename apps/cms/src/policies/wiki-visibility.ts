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
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;

  // Anonymous traffic can read public spaces only. We mutate the query
  // filters so Strapi's core find handler does the heavy lifting.
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
