export default {
  async afterCreate(event: any) {
    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForEvent(result);
  },

  async afterUpdate(event: any) {
    const { result, params } = event;
    if (!result?.publishedAt) return;
    const previousData = params?.data;
    if (previousData && !previousData.publishedAt && result.publishedAt) {
      await notifyForEvent(result);
    }
  },
};

async function notifyForEvent(ev: any) {
  try {
    const full = await strapi.db.query("api::event.event").findOne({
      where: { id: ev.id },
      populate: { departments: true, organizer: true },
    });

    let recipients: any[];
    if (full?.departments?.length) {
      const deptIds = full.departments.map((d: any) => d.id);
      recipients = await strapi.db.query("plugin::users-permissions.user").findMany({
        where: { department: { id: { $in: deptIds } } },
      });
    } else {
      recipients = await strapi.db.query("plugin::users-permissions.user").findMany({});
    }

    const organizerId = full?.organizer?.id;
    for (const user of recipients) {
      if (user.id === organizerId) continue;
      await strapi.db.query("api::notification.notification").create({
        data: {
          type: "event",
          title: `New event: ${ev.title ?? "Untitled"}`,
          link: "/events",
          recipient: user.id,
          actor: organizerId ?? null,
        },
      });
    }
    strapi.log.info(
      `[notifications] created ${recipients.length} notification(s) for event ${ev.id}`,
    );
  } catch (err) {
    strapi.log.error(
      `[notifications] failed to create notifications for event: ${(err as Error).message}`,
    );
  }
}
