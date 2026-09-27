import { parseEntryRef } from "../utils/entry-id";

/**
 * Delete-side guard for reactions: only the author may remove a reaction.
 * Admins and editors pass (same moderation semantics as comment delete).
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (["admin_role", "editor"].includes(user.role?.type)) return true;

  // v5 routes carry a documentId; accept a numeric id too so direct API
  // consumers keep working (same gotcha as in the comment controller). A
  // missing or malformed id is refused like an unknown reaction, before
  // any query (utils/entry-id.ts).
  const where = parseEntryRef(policyContext.params?.id);
  if (!where) return false;

  const reaction = await strapi.db.query("api::reaction.reaction").findOne({
    where,
    populate: { author: true },
  });
  if (!reaction) return false;

  return reaction.author?.id === user.id;
};
