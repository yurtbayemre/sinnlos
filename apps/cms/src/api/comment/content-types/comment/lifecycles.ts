import { findCommentTarget } from "../../../../utils/comment-target";

export default {
  async afterCreate(event: any) {
    const { result } = event;
    try {
      const full = await strapi.db.query("api::comment.comment").findOne({
        where: { id: result.id },
        populate: { author: true },
      });
      if (!full) return;

      // Only announcement comments notify anybody: wiki pages have no
      // author-notification feature yet (the wiki-page branch of targetType
      // exists in the schema and is handled by findCommentTarget, it just has
      // no recipient to fan out to here).
      if (full.targetType === "announcement") {
        // Resolve via the documentId anchor, NOT the numeric targetId: the
        // published row id changes on every re-publish (delete+recreate), so
        // an id lookup either found nothing or — after id recycling — the
        // wrong announcement, and the author of a foreign entry got the
        // notification (issue #11). findCommentTarget still falls back to
        // targetId for rows the bootstrap backfill could not anchor yet.
        const announcement = await findCommentTarget(strapi, full, {
          populate: { author: true },
        });
        if (announcement?.author?.id && announcement.author.id !== full.author?.id) {
          await strapi.db.query("api::notification.notification").create({
            data: {
              type: "comment",
              title: `${full.author?.displayName ?? "Someone"} commented on "${announcement.title ?? "an announcement"}"`,
              link: "/announcements",
              recipient: announcement.author.id,
              actor: full.author?.id ?? null,
            },
          });
        }
      }
    } catch (err) {
      strapi.log.error(
        `[notifications] failed for comment: ${(err as Error).message}`,
      );
    }
  },
};
