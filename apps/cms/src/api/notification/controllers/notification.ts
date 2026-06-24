import { factories } from "@strapi/strapi";

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
    return ctx.send({ updated: count });
  },
}));
