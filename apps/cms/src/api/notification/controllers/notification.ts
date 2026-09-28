import { factories } from "@strapi/strapi";
import { parseEntryRef, parseRowId } from "../../../utils/entry-id";
import { emitLiveEvent } from "../../../utils/live-events";

/** Most ids one mark-read call takes (the web marks one at a time). */
const MARK_READ_MAX_IDS = 200;

export default factories.createCoreController("api::notification.notification", ({ strapi }) => ({
  async markRead(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const raw = ((ctx.request.body ?? {}) as { ids?: unknown }).ids;
    if (!Array.isArray(raw) || raw.length === 0) return ctx.badRequest("ids required");
    if (raw.length > MARK_READ_MAX_IDS) {
      return ctx.badRequest(`at most ${MARK_READ_MAX_IDS} ids per call`);
    }
    // Row ids only (numbers or decimal strings within int4), checked before
    // any query: anything else made the Postgres lookup fail with a 500
    // (utils/entry-id.ts).
    const parsed = raw.map(parseRowId);
    if (parsed.includes(null)) return ctx.badRequest("ids must be notification ids");
    const ids = [...new Set(parsed as number[])];

    // ONE statement, bound to the caller (FX27): only the caller's own
    // unread rows among `ids` change, whatever else the list names. The
    // count is the number of rows that were actually unread.
    const { count } = await strapi.db.query("api::notification.notification").updateMany({
      where: { id: { $in: ids }, recipient: user.id, readAt: null },
      data: { readAt: new Date().toISOString() },
    });
    // Emit here, not via lifecycle: updateMany fires afterUpdateMany, which
    // carries only the where clause and a count. This handler already knows
    // the recipient — it is the caller.
    if (count > 0) emitLiveEvent({ kind: "notification", recipientId: user.id });
    return ctx.send({ updated: count });
  },

  async markAllRead(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const now = new Date().toISOString();
    const { count } = await strapi.db.query("api::notification.notification").updateMany({
      where: { recipient: user.id, readAt: null },
      data: { readAt: now },
    });
    // updateMany fires afterUpdateMany, which carries only the where
    // clause and a count — no rows. Emit directly so the user's other
    // tabs sync their unread badge without waiting for the backstop poll.
    if (count > 0) emitLiveEvent({ kind: "notification", recipientId: user.id });
    return ctx.send({ updated: count });
  },

  /**
   * DELETE /api/notifications/:id, behind global::is-notification-recipient
   * (recipient or admin_role). `:id` is a documentId or a numeric row id
   * (PL01, owner default "translate"): the v5 core controller resolves only
   * documentIds, so a numeric id deleted nothing and still answered 204 —
   * for admins, whose policy bypass never looks the row up. It is translated
   * here; a malformed id or a missing row answers 404 (utils/entry-id.ts).
   */
  async delete(ctx) {
    const where = parseEntryRef(ctx.params.id);
    if (!where) return ctx.notFound();
    const entity = await strapi.db.query("api::notification.notification").findOne({
      where,
      select: ["id", "documentId"],
    });
    if (!entity) return ctx.notFound();
    ctx.params.id = entity.documentId;
    return super.delete(ctx);
  },
}));
