import { resolveFanout } from "../../../../utils/notification-source";

export default {
  async afterCreate(event: any) {
    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForEvent(result);
  },

  // Second notify path, deliberately KEPT (issue #12) — same reasoning as in
  // announcement/lifecycles.ts, keep both files in sync.
  //
  // event is draftAndPublish and the documents-service publish path is
  // delete-then-recreate, so a (re-)publish surfaces as afterCreate with
  // publishedAt set, while a normal save keeps the draft (publishedAt null)
  // and returns below — this hook almost never notifies. But a write that
  // flips publishedAt in place (db-layer update from a script/import, or a
  // future core change to the publish implementation) is a publish that
  // afterCreate would MISS entirely.
  //
  // That used to be a duplicate-notification risk, which is why the earlier
  // beforeUpdate/wasPublished guard was bolted on — aimed at the wrong
  // trigger and removed again. Now the fan-out is deduped per (source
  // document, recipient) (notifyForEvent → resolveFanout), so whichever hook
  // runs first writes the anchored notifications and the other one finds them
  // and has nobody left to notify. Keeping this path costs one findMany() and
  // buys the safety net.
  async afterUpdate(event: any) {
    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForEvent(result);
  },
};

async function notifyForEvent(ev: any) {
  try {
    const full = await strapi.db.query("api::event.event").findOne({
      where: { id: ev.id },
      populate: { departments: true, organizer: true },
    });

    let users: any[];
    if (full?.departments?.length) {
      const deptIds = full.departments.map((d: any) => d.id);
      users = await strapi.db.query("plugin::users-permissions.user").findMany({
        where: { department: { id: { $in: deptIds } } },
      });
    } else {
      users = await strapi.db.query("plugin::users-permissions.user").findMany({});
    }

    const organizerId = full?.organizer?.id;
    const audience = (users ?? []).filter((user: any) => user.id !== organizerId);

    // Dedup per (source document, RECIPIENT) — issue #12, same reasoning as
    // in announcement/lifecycles.ts, keep both files in sync. Publishing in
    // Strapi 5 is delete+recreate, so every re-publish re-ran this fan-out
    // and notified everyone again. Notifications carry the source anchor
    // (sourceType + sourceDocumentId — the documentId, NOT the numeric row
    // id, which changes with every publish, §5.17); resolveFanout loads the
    // users that already hold a row for this anchor and returns only the rest
    // of the audience.
    //
    // Recipient granularity matters here as much as for announcements: an
    // event re-targeted to another department still reaches it, and a fan-out
    // that dies half-way heals itself on the next publish — which is why the
    // write loop below needs no transaction bracket. Remaining limit
    // (accepted, same as ack/rsvp in §7b / issue #16): check-then-insert, so
    // two publishes in a real race can both write; no DB unique index is
    // possible because `recipient` lives in a link table.
    //
    // Legacy rows (created before these fields existed) carry no anchor and
    // cannot match: the FIRST re-publish of an old event notifies once more,
    // every publish after that is deduped. Accepted instead of backfilling —
    // the only link back to the source is the title inside the notification
    // text, which is neither unique nor stable, so a backfill could anchor
    // old rows to the wrong document and permanently suppress a real
    // notification. See docs/architecture.md §7b / issue #12.
    const { recipients, anchor } = await resolveFanout(
      strapi,
      "event",
      full ?? ev,
      audience,
      (user: any) => user.id,
    );

    const rows = recipients.map((user: any) => ({
      type: "event",
      title: `New event: ${ev.title ?? "Untitled"}`,
      link: "/events",
      recipient: user.id,
      actor: organizerId ?? null,
      // Anchor for the dedup above; null only if the source had no
      // documentId (then resolveFanout already logged a warning).
      sourceType: "event",
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
      `[notifications] created ${rows.length} notification(s) for event ${ev.id} ` +
        `(source ${anchor?.sourceDocumentId ?? "unanchored"})`,
    );
  } catch (err) {
    strapi.log.error(
      `[notifications] failed to create notifications for event: ${(err as Error).message}`,
    );
  }
}
