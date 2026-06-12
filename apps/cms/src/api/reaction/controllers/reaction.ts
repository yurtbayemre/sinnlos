import { factories } from "@strapi/strapi";

export default factories.createCoreController("api::reaction.reaction", ({ strapi }) => ({
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = ((ctx.request.body as any)?.data ?? ctx.request.body) as any;
    const { emoji, targetType, targetId } = body;

    const existing = await strapi.db.query("api::reaction.reaction").findOne({
      where: {
        emoji,
        targetType,
        targetId,
        author: user.id,
      },
    });

    if (existing) {
      await strapi.db.query("api::reaction.reaction").delete({
        where: { id: existing.id },
      });
      return ctx.send({ data: null, toggled: "removed" });
    }

    ctx.request.body = {
      data: { emoji, targetType, targetId, author: user.id },
    };
    return super.create(ctx);
  },
}));
