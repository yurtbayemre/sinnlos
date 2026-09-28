import { ADMIN } from "../bootstrap/roles";
import { parseEntryRef } from "../utils/entry-id";

/**
 * Delete-side guard for notifications: only the recipient (or an admin)
 * may delete a notification.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (user.role?.type === ADMIN) return true;

  // v5 routes carry a documentId; accept a numeric id too so direct API
  // consumers keep working (same gotcha as in the comment controller). A
  // missing or malformed id is refused like an unknown notification,
  // before any query (utils/entry-id.ts).
  const where = parseEntryRef(policyContext.params?.id);
  if (!where) return false;

  const notification = await strapi.db.query("api::notification.notification").findOne({
    where,
    populate: { recipient: true },
  });
  if (!notification) return false;

  return notification.recipient?.id === user.id;
};
