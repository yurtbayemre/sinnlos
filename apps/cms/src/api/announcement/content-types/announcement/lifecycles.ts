import { isAnnouncementVisible } from "../../../../utils/announcement-audience";
import { resolveFanout } from "../../../../utils/notification-source";
import { revalidate } from "../../../../utils/revalidate";

export default {
  async afterCreate(event: any) {
    await revalidate(["announcements"]);

    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForAnnouncement(result);
  },

  // Second notify path, deliberately KEPT (issue #12).
  //
  // announcement is draftAndPublish and the documents-service publish path is
  // delete-then-recreate, so a (re-)publish surfaces as afterCreate with
  // publishedAt set, while a normal save keeps the draft (publishedAt null)
  // and returns below — this hook almost never notifies. "Almost never" is
  // not "never" though: a write that flips publishedAt in place (db-layer
  // update from a script/import, or a future core change to the publish
  // implementation) is a publish that afterCreate would MISS entirely.
  //
  // That used to be a duplicate-notification risk, which is why the earlier
  // beforeUpdate/wasPublished guard was bolted on — aimed at the wrong
  // trigger and removed again. Now the fan-out is deduped per (source
  // document, recipient) (notifyForAnnouncement → resolveFanout), so
  // whichever hook runs first writes the anchored notifications and the other
  // one finds them and has nobody left to notify. Keeping this path costs one
  // findMany() and buys the safety net.
  // The revalidate() below is required here regardless of notifications.
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
    const authorId = full?.author?.id;
    const audience = (users ?? [])
      .filter((user: any) =>
        isAnnouncementVisible(full ?? {}, {
          roleId: user.role?.id,
          departmentId: user.department?.id,
          teamIds: [
            ...(user.teams ?? []).map((team: { id: number }) => team.id),
            ...(ledTeamIds.get(user.id) ?? []),
          ],
        }),
      )
      .filter((user: any) => user.id !== authorId);

    // Dedup per (source document, RECIPIENT) — issue #12. Publishing in
    // Strapi 5 is delete+recreate, so every re-publish re-ran this fan-out
    // and notified the whole audience again. Notifications carry the source
    // anchor (sourceType + sourceDocumentId — the documentId, NOT the numeric
    // row id, which changes with every publish, §5.17); resolveFanout loads
    // the users that already hold a row for this anchor and returns only the
    // rest of the audience.
    //
    // Recipient granularity, not source granularity, on purpose: a
    // re-targeted announcement (published to department A, corrected to B,
    // published again) still reaches B, and a fan-out that dies half-way
    // heals itself on the next publish — which is exactly why this loop needs
    // no transaction bracket: a partial write is a recoverable state.
    // Remaining limit (accepted, same as ack/rsvp in §7b / issue #16): this is
    // check-then-insert, so two publishes racing each other can both write —
    // no DB unique index is possible because `recipient` lives in a link
    // table.
    //
    // Legacy rows (the ~106 notifications created before these fields
    // existed) carry no anchor and cannot match: the FIRST re-publish of an
    // old announcement notifies its audience once more, every publish after
    // that is deduped. Accepted instead of backfilling — the only link back
    // to the source is the title embedded in the notification text, which is
    // neither unique nor stable (rename an announcement, create a new one
    // reusing the old title, and the backfill would anchor the old rows to
    // the new document and permanently suppress a real notification).
    // Guessing in production data is the worse trade. See §7b / issue #12.
    const { recipients, anchor } = await resolveFanout(
      strapi,
      "announcement",
      full ?? announcement,
      audience,
      (user: any) => user.id,
    );

    const rows = recipients.map((user: any) => ({
      type: "announcement",
      title: `New announcement: ${announcement.title ?? "Untitled"}`,
      link: "/announcements",
      recipient: user.id,
      actor: authorId ?? null,
      // Anchor for the dedup above; null only if the source had no
      // documentId (then resolveFanout already logged a warning).
      sourceType: "announcement",
      sourceDocumentId: anchor?.sourceDocumentId ?? null,
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
    // Note: an empty audience writes no rows, so nothing anchors this source
    // and the next publish evaluates the fan-out again — correct, nobody has
    // been notified yet. Same for an aborted loop: the rows written so far
    // anchor exactly their recipients, the next publish delivers the rest.
    strapi.log.info(
      `[notifications] created ${rows.length} notification(s) for announcement ${announcement.id} ` +
        `(source ${anchor?.sourceDocumentId ?? "unanchored"})`,
    );
  } catch (err) {
    strapi.log.error(
      `[notifications] failed to create notifications for announcement: ${(err as Error).message}`,
    );
  }
}
