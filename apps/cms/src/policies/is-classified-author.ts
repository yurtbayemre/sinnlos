/**
 * Write-side guard for marketplace ads: only the author may update or
 * delete their classified. Which roles bypass ownership is configurable
 * per route via `config.bypassRoles`:
 *   - update: ["admin_role"] — editing someone's ad text/price is an
 *     owner/admin matter, not moderation.
 *   - delete: ["admin_role", "editor"] — taking down an inappropriate ad
 *     stays an editor moderation tool (same semantics as
 *     is-reaction-author / comment delete).
 * Default (no config) keeps the historical admin+editor bypass.
 */
export default async (
  policyContext: any,
  config: { bypassRoles?: string[] } | undefined,
  { strapi }: any,
) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  const bypassRoles = config?.bypassRoles ?? ["admin_role", "editor"];
  if (bypassRoles.includes(user.role?.type)) return true;

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
