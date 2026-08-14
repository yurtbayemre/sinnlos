/**
 * Allows access if the authenticated user is a member or lead of the
 * target team, or is an admin/editor/department_head for that team's
 * department.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user?.role?.type) return false;

  if (["admin_role", "editor"].includes(user.role.type)) return true;

  const targetId = policyContext.params?.id;
  if (!targetId) return true;

  // v5 routes carry a documentId; accept a numeric id too so direct API
  // consumers keep working (same gotcha as in the comment controller).
  const idParam = String(targetId);
  const team = await strapi.db.query("api::team.team").findOne({
    where: /^\d+$/.test(idParam) ? { id: Number(idParam) } : { documentId: idParam },
    populate: { lead: true, members: true, department: true },
  });
  if (!team) return false;

  const meFull = await strapi.db.query("plugin::users-permissions.user").findOne({
    where: { id: user.id },
    populate: { department: true, teams: true },
  });

  if (team.lead?.id === user.id) return true;
  if ((team.members ?? []).some((m: { id: number }) => m.id === user.id)) return true;
  if (
    user.role.type === "department_head" &&
    meFull?.department?.id === team.department?.id
  ) {
    return true;
  }

  return false;
};
