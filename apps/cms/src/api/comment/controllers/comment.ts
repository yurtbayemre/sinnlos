import { factories } from "@strapi/strapi";

export default factories.createCoreController("api::comment.comment", ({ strapi }) => ({
  async create(ctx) {
    ctx.request.body = ctx.request.body ?? {};
    const body = ctx.request.body as any;
    if (body.data) {
      body.data.author = ctx.state.user?.id;
    } else {
      body.data = { ...body, author: ctx.state.user?.id };
    }
    return super.create(ctx);
  },

  async delete(ctx) {
    const entity = await strapi.db.query("api::comment.comment").findOne({
      where: { id: ctx.params.id },
      populate: { author: true },
    });
    if (!entity) return ctx.notFound();
    const user = ctx.state.user;
    const isOwner = entity.author?.id === user?.id;
    const isPrivileged = ["admin_role", "editor"].includes(user?.role?.type);
    if (!isOwner && !isPrivileged) return ctx.forbidden();
    return super.delete(ctx);
  },
}));
