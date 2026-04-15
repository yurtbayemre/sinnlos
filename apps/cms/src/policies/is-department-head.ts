/**
 * Allows access if:
 *   - the user is an admin/editor, OR
 *   - the user's role type is department_head AND their department matches
 *     the target entity's department relation.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user?.role?.type) return false;

  if (["admin_role", "editor"].includes(user.role.type)) return true;
  if (user.role.type !== "department_head") return false;

  const targetId = policyContext.params?.id;
  if (!targetId) return true; // collection-level create: further checks in controller

  const entity = await strapi.db.query("api::department.department").findOne({
    where: { id: targetId },
    populate: { members: true },
  });
  if (!entity) return false;

  const meFull = await strapi.db.query("plugin::users-permissions.user").findOne({
    where: { id: user.id },
    populate: { department: true },
  });

  return meFull?.department?.id === entity.id;
};
