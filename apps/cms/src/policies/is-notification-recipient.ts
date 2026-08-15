/**
 * Delete-side guard for notifications: only the recipient (or an admin)
 * may delete a notification.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (user.role?.type === "admin_role") return true;

  // v5 routes carry a documentId; accept a numeric id too so direct API
  // consumers keep working (same gotcha as in the comment controller).
  const idParam = String(policyContext.params?.id ?? "");
  if (!idParam) return false;

  const notification = await strapi.db.query("api::notification.notification").findOne({
    where: /^\d+$/.test(idParam) ? { id: Number(idParam) } : { documentId: idParam },
    populate: { recipient: true },
  });
  if (!notification) return false;

  return notification.recipient?.id === user.id;
};
