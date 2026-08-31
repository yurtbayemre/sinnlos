import { factories } from "@strapi/strapi";
import { WRITE_TARGET_ERRORS, resolveWriteTarget } from "../../../utils/comment-target";
import { isTargetVisible } from "../../../utils/target-visibility";

export default factories.createCoreController("api::comment.comment", ({ strapi }) => ({
  /**
   * Author is server-authoritative (§5.21) and the target is anchored by
   * documentId, never by the numeric row id: publishing an announcement in
   * Strapi 5 is delete+recreate, so an id-anchored comment detaches on the
   * next "Publish" (issue #11, see utils/comment-target.ts).
   *
   * Only the documentId anchor is accepted (#25 removed the targetId
   * migration bridge): a payload carrying nothing but the legacy `targetId`
   * is answered with 400 "targetDocumentId required".
   */
  async create(ctx) {
    ctx.request.body = ctx.request.body ?? {};
    const body = ctx.request.body as any;
    const data = body.data ?? body;

    // `targetId` is stripped here on purpose: it is no longer a schema
    // attribute, and forwarding an old client's extra key to the core create
    // would risk an "Invalid key" rejection.
    const { targetType: _t, targetDocumentId: _d, targetId: _i, ...rest } = data ?? {};

    const target = await resolveWriteTarget(strapi, data);
    if (target.status === "rejected") return ctx.badRequest(WRITE_TARGET_ERRORS[target.reason]);

    // #28: an existing-but-invisible target answers with the EXACT same
    // 400 as a nonexistent one — create must not become an existence
    // oracle for documentIds the caller may not read (§5.17).
    const visible = await isTargetVisible(
      strapi,
      target.targetType,
      target.targetDocumentId,
      ctx.state.user,
    );
    if (!visible) return ctx.badRequest(WRITE_TARGET_ERRORS["unresolved-target"]);

    ctx.request.body = {
      data: {
        ...rest,
        targetType: target.targetType,
        targetDocumentId: target.targetDocumentId,
        author: ctx.state.user?.id,
      },
    };
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
