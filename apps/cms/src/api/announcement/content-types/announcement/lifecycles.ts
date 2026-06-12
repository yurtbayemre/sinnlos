import { revalidate } from "../../../../utils/revalidate";

export default {
  async afterCreate(event: any) {
    await revalidate(["announcements"]);

    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForAnnouncement(result);
  },

  async afterUpdate(event: any) {
    await revalidate(["announcements"]);

    const { result, params } = event;
    if (!result?.publishedAt) return;
    const previousData = params?.data;
    if (previousData && !previousData.publishedAt && result.publishedAt) {
      await notifyForAnnouncement(result);
    }
  },

  async afterDelete() {
    await revalidate(["announcements"]);
  },
};

async function notifyForAnnouncement(announcement: any) {
  try {
    const full = await strapi.db.query("api::announcement.announcement").findOne({
      where: { id: announcement.id },
      populate: { department: true, author: true },
    });

    let recipients: any[];
    if (full?.department?.id && full?.audience === "departments") {
      recipients = await strapi.db.query("plugin::users-permissions.user").findMany({
        where: { department: full.department.id },
      });
    } else {
      recipients = await strapi.db.query("plugin::users-permissions.user").findMany({});
    }

    const authorId = full?.author?.id;
    for (const user of recipients) {
      if (user.id === authorId) continue;
      await strapi.db.query("api::notification.notification").create({
        data: {
          type: "announcement",
          title: `New announcement: ${announcement.title ?? "Untitled"}`,
          link: "/announcements",
          recipient: user.id,
          actor: authorId ?? null,
        },
      });
    }
    strapi.log.info(
      `[notifications] created ${recipients.length} notification(s) for announcement ${announcement.id}`,
    );
  } catch (err) {
    strapi.log.error(
      `[notifications] failed to create notifications for announcement: ${(err as Error).message}`,
    );
  }
}
