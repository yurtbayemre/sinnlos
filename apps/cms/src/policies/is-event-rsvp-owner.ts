import { parseEntryRef } from "../utils/entry-id";

/**
 * Update-side guard for event RSVPs: only the responding user may change
 * their own answer. admin_role bypasses (it may also correct/delete RSVPs
 * via the matrix); editors get NO moderation bypass here — an RSVP is a
 * personal statement, not content.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (user.role?.type === "admin_role") return true;

  // v5 routes carry a documentId; the web app sends numeric ids — accept
  // both (same gotcha as in the comment controller). A missing or
  // malformed id is refused like an unknown RSVP, before any query
  // (utils/entry-id.ts).
  const where = parseEntryRef(policyContext.params?.id);
  if (!where) return false;

  const rsvp = await strapi.db.query("api::event-rsvp.event-rsvp").findOne({
    where,
    populate: { user: true },
  });
  if (!rsvp) return false;

  return rsvp.user?.id === user.id;
};
