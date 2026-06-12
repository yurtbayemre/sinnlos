export default {
  async afterCreate(event: any) {
    const { result } = event;
    try {
      const full = await strapi.db.query("api::comment.comment").findOne({
        where: { id: result.id },
        populate: { author: true },
      });
      if (!full) return;

      if (full.targetType === "announcement") {
        const announcement = await strapi.db.query("api::announcement.announcement").findOne({
          where: { id: full.targetId },
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
