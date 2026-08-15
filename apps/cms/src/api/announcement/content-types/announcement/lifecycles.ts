import { revalidate } from "../../../../utils/revalidate";

export default {
  async afterCreate(event: any) {
    await revalidate(["announcements"]);

    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForAnnouncement(result);
  },

  // NOTE on re-notify (OPEN ISSUE): the beforeUpdate/event.state.wasPublished
  // guard added by an earlier audit was removed because it targeted the
  // wrong trigger. announcement + event are draftAndPublish, and the
  // documents-service publish path is delete-then-recreate: a (re-)publish
  // fires afterCreate (with publishedAt set), while a normal save/update
  // keeps the draft (publishedAt null), so this afterUpdate almost never
  // fires. The remaining, unfixed issue is that re-publishing re-runs
  // afterCreate's fan-out and creates duplicate notifications. A safe dedup
  // would key on the source document, but the notification schema has no
  // reference back to its announcement/event (only type/title/link), so
  // deduping would require a new schema field — deliberately NOT forced
  // here. This keeps the original heuristic (no worse than before).
  async afterUpdate(event: any) {
    await revalidate(["announcements"]);

    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForAnnouncement(result);
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
    const rows = recipients
      .filter((user) => user.id !== authorId)
      .map((user) => ({
        type: "announcement",
        title: `New announcement: ${announcement.title ?? "Untitled"}`,
        link: "/announcements",
        recipient: user.id,
        actor: authorId ?? null,
      }));
    // Per-row create(), NOT createMany(): @strapi/database's createMany
    // (entity-manager index.js:247) only runs processData + a raw insert
    // and skips attachRelations, so the `recipient`/`actor` join-table
    // relations are silently dropped — every row would land with a null
    // recipient and be invisible to the visibility filter. Only create()
    // (index.js:219) attaches relations. Verified against @strapi/database
    // 5.49 (unidirectional manyToOne → join table via createManyToOne).
    for (const row of rows) {
      await strapi.db.query("api::notification.notification").create({ data: row });
    }
    strapi.log.info(
      `[notifications] created ${rows.length} notification(s) for announcement ${announcement.id}`,
    );
  } catch (err) {
    strapi.log.error(
      `[notifications] failed to create notifications for announcement: ${(err as Error).message}`,
    );
  }
}
