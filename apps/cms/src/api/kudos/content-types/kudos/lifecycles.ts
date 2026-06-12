export default {
  async afterCreate(event: any) {
    const { result } = event;
    try {
      const full = await strapi.db.query("api::kudos.kudos").findOne({
        where: { id: result.id },
        populate: { from: true, to: true },
      });
      if (!full?.to?.id || !full?.from?.id) return;
      if (full.to.id === full.from.id) return;

      await strapi.db.query("api::notification.notification").create({
        data: {
          type: "kudos",
          title: `${full.from.displayName ?? "Someone"} gave you kudos!`,
          link: "/kudos",
          recipient: full.to.id,
          actor: full.from.id,
        },
      });
    } catch (err) {
      strapi.log.error(
        `[notifications] failed for kudos: ${(err as Error).message}`,
      );
    }
  },
};
