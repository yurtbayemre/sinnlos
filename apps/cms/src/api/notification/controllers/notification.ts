import { factories } from "@strapi/strapi";
import { emitLiveEvent } from "../../../utils/live-events";

export default factories.createCoreController("api::notification.notification", ({ strapi }) => ({
  async markRead(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const { ids } = ctx.request.body as { ids?: number[] };
    if (!ids?.length) return ctx.badRequest("ids required");

    const now = new Date().toISOString();
    let updated = 0;
    for (const id of ids) {
      const notif = await strapi.db.query("api::notification.notification").findOne({
        where: { id, recipient: user.id },
      });
      if (notif && !notif.readAt) {
        await strapi.db.query("api::notification.notification").update({
          where: { id },
          data: { readAt: now },
        });
        updated++;
      }
    }
    // Emit here, not via lifecycle: db.query updates fire per-row events
    // whose result rows don't populate the recipient relation. This
    // handler already knows the recipient — it is the caller.
    if (updated > 0) emitLiveEvent({ kind: "notification", recipientId: user.id });
    return ctx.send({ updated });
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
}));
