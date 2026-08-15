import { isAnnouncementVisible } from "../../../../utils/announcement-audience";
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
      populate: { department: true, team: true, audienceRoles: true, author: true },
    });

    // Notify exactly the targeted audience — the notification carries the
    // announcement title, so a broader fan-out would leak the very thing
    // the announcement-visibility policy hides. Same rules as the policy
    // (utils/announcement-audience.ts): department AND team AND role, over
    // whatever is set. A missing row (should not happen) targets everyone,
    // which is the previous behaviour.
    const [users, teams] = await Promise.all([
      strapi.db.query("plugin::users-permissions.user").findMany({
        populate: {
          department: { select: ["id"] },
          teams: { select: ["id"] },
          role: { select: ["id"] },
        },
      }),
      strapi.db.query("api::team.team").findMany({
        select: ["id"],
        populate: { lead: { select: ["id"] } },
      }),
    ]);
    // team.lead has no inverse field on the user, so build the reverse map.
    const ledTeamIds = new Map<number, number[]>();
    for (const team of teams ?? []) {
      const leadId = team.lead?.id;
      if (leadId == null) continue;
      ledTeamIds.set(leadId, [...(ledTeamIds.get(leadId) ?? []), team.id]);
    }
    const recipients = (users ?? []).filter((user: any) =>
      isAnnouncementVisible(full ?? {}, {
        roleId: user.role?.id,
        departmentId: user.department?.id,
        teamIds: [
          ...(user.teams ?? []).map((team: { id: number }) => team.id),
          ...(ledTeamIds.get(user.id) ?? []),
        ],
      }),
    );

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
