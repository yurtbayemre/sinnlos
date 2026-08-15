/**
 * Write-side guard for marketplace ads: only the author may update or
 * delete their classified. Admins and editors pass for moderation (same
 * semantics as is-reaction-author / comment delete).
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (["admin_role", "editor"].includes(user.role?.type)) return true;

  // v5 routes carry a documentId; the web app sends numeric ids — accept
  // both (same gotcha as in the comment controller).
  const idParam = String(policyContext.params?.id ?? "");
  if (!idParam) return false;

  const classified = await strapi.db.query("api::classified.classified").findOne({
    where: /^\d+$/.test(idParam) ? { id: Number(idParam) } : { documentId: idParam },
    populate: { author: true },
  });
  if (!classified) return false;

  return classified.author?.id === user.id;
};
