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
    // The web app addresses comments by numeric id; accept both that and a
    // documentId so direct API consumers keep working.
    const idParam = String(ctx.params.id);
    const entity = await strapi.db.query("api::comment.comment").findOne({
      where: /^\d+$/.test(idParam)
        ? { id: Number(idParam) }
        : { documentId: idParam },
      populate: { author: true },
    });
    if (!entity) return ctx.notFound();
    const user = ctx.state.user;
    const isOwner = entity.author?.id === user?.id;
    const isPrivileged = ["admin_role", "editor"].includes(user?.role?.type);
    if (!isOwner && !isPrivileged) return ctx.forbidden();
    // The v5 core controller resolves by documentId — a numeric id deletes
    // nothing while still answering 204, so translate before delegating.
    ctx.params.id = entity.documentId;
    return super.delete(ctx);
  },
}));
