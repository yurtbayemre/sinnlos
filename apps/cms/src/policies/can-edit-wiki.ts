/**
 * Write-side guard for wiki pages. Admins/editors always pass.
 * Department heads can edit pages whose department matches theirs.
 * Team leads can edit pages whose team they lead.
 * Members can edit pages they authored.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;
  if (["admin_role", "editor"].includes(user.role?.type)) return true;

  const targetId = policyContext.params?.id;
  if (!targetId) {
    // Creating a new page: allowed for any authenticated non-guest.
    return user.role?.type !== "guest";
  }

  const page = await strapi.db.query("api::wiki-page.wiki-page").findOne({
    where: { id: targetId },
    populate: {
      author: true,
      department: true,
      team: { populate: { lead: true, members: true } },
    },
  });
  if (!page) return false;

  if (page.author?.id === user.id) return true;

  if (user.role?.type === "department_head") {
    const me = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: user.id },
      populate: { department: true },
    });
    if (me?.department?.id && me.department.id === page.department?.id) return true;
  }

  if (user.role?.type === "team_lead" && page.team?.lead?.id === user.id) return true;

  return false;
};
