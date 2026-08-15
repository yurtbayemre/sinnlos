import { factories } from "@strapi/strapi";

/**
 * Acknowledgements follow the poll-vote integrity pattern: the caller can
 * NEVER pick the acknowledging user — it is always taken from
 * ctx.state.user, and duplicates / invalid targets are rejected
 * server-side.
 *
 * Target anchoring — documentId, NOT the numeric id:
 *   Strapi 5 publishes by DELETING and RE-CREATING the published row, so
 *   the numeric `id` of a published entry changes on every re-publish. An
 *   ack anchored to the numeric id would silently detach from its
 *   announcement the next time an editor hits "Publish". The `documentId`
 *   is stable across the whole draft/publish lifecycle, so acks reference
 *   `targetType` + `targetDocumentId` (string) instead.
 */
const TARGET_UIDS: Record<string, string> = {
  announcement: "api::announcement.announcement",
  document: "api::document.document",
};

export default factories.createCoreController(
  "api::acknowledgement.acknowledgement",
  ({ strapi }) => ({
    async create(ctx) {
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized();

      const body = (ctx.request.body ?? {}) as any;
      const data = body.data ?? body;
      const targetType = data?.targetType as string | undefined;
      const targetDocumentId = data?.targetDocumentId;

      const targetUid = targetType ? TARGET_UIDS[targetType] : undefined;
      if (!targetUid) return ctx.badRequest("Invalid targetType");
      if (typeof targetDocumentId !== "string" || targetDocumentId.length === 0) {
        return ctx.badRequest("targetDocumentId required");
      }

      // The target must exist as a PUBLISHED entry and actually require
      // acknowledgement. Documents currently have no requiresAck field, so
      // document acks are rejected here until the schema grows one — the
      // enum value is only prepared.
      const target = await strapi.db.query(targetUid).findOne({
        where: { documentId: targetDocumentId, publishedAt: { $notNull: true } },
      });
      // Deliberately ONE identical error (message + status) for all three
      // failure modes — "does not exist", "draft only" and
      // "requiresAck=false" — so the endpoint is no existence oracle for
      // draft documentIds.
      if (!target || !target.requiresAck) {
        return ctx.badRequest("Target not available for acknowledgement");
      }

      // One acknowledgement per user + target.
      //
      // NOTE — accepted check-then-insert race (same pattern as the
      // poll-vote controller): two concurrent creates for the same
      // (user, targetType, targetDocumentId) can both pass this check and
      // insert two rows. A DB unique index would be the airtight fix, but
      // `user` is a relation via a link table, so there is no single-table
      // column set to index without fighting Strapi's schema management.
      // All consumers (dashboard banner, /announcements page, admin
      // report) dedupe by Set/Map over targetDocumentId, so a duplicate
      // row is cosmetic, never a correctness issue.
      const existing = await strapi.db
        .query("api::acknowledgement.acknowledgement")
        .findOne({ where: { user: user.id, targetType, targetDocumentId } });
      if (existing) return ctx.badRequest("Already acknowledged");

      // Single-row db.query create — attaches the user relation correctly
      // (createMany would NOT link relations).
      const ack = await strapi.db.query("api::acknowledgement.acknowledgement").create({
        data: {
          user: user.id,
          targetType,
          targetDocumentId,
          acknowledgedAt: new Date().toISOString(),
        },
      });
      return ctx.send({ data: ack });
    },
  }),
);
