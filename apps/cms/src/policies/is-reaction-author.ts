/**
 * Delete-side guard for reactions: only the author may remove a reaction.
 * Admins and editors pass (same moderation semantics as comment delete).
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (["admin_role", "editor"].includes(user.role?.type)) return true;

  // v5 routes carry a documentId; accept a numeric id too so direct API
  // consumers keep working (same gotcha as in the comment controller).
  const idParam = String(policyContext.params?.id ?? "");
  if (!idParam) return false;

  const reaction = await strapi.db.query("api::reaction.reaction").findOne({
    where: /^\d+$/.test(idParam) ? { id: Number(idParam) } : { documentId: idParam },
    populate: { author: true },
  });
  if (!reaction) return false;

  return reaction.author?.id === user.id;
};
