import { factories } from "@strapi/strapi";
import { WRITE_TARGET_ERRORS, resolveWriteTarget } from "../../../utils/comment-target";

export default factories.createCoreController("api::comment.comment", ({ strapi }) => ({
  /**
   * Author is server-authoritative (§5.21) and the target is anchored by
   * documentId, never by the numeric row id: publishing an announcement in
   * Strapi 5 is delete+recreate, so an id-anchored comment detaches on the
   * next "Publish" (issue #11, see utils/comment-target.ts).
   *
   * TEMPORARY MIGRATION BRIDGE (issue #11, removed by its follow-up ticket
   * together with the `targetId` column): `resolveWriteTarget` also accepts a
   * payload that carries ONLY the deprecated `targetId` — an old web
   * container against this CMS, the partial rollback documented in
   * infra/deploy.sh — and writes BOTH keys, so a full rollback to the id-only
   * code still sees the rows created in the meantime. The client-supplied
   * targetId is never stored as-is; the resolved target's current row id is.
   */
  async create(ctx) {
    ctx.request.body = ctx.request.body ?? {};
    const body = ctx.request.body as any;
    const data = body.data ?? body;

    const target = await resolveWriteTarget(strapi, data);
    if (target.status === "rejected") return ctx.badRequest(WRITE_TARGET_ERRORS[target.reason]);

    const { targetType: _t, targetDocumentId: _d, targetId: _i, ...rest } = data ?? {};
    ctx.request.body = {
      data: {
        ...rest,
        targetType: target.targetType,
        targetDocumentId: target.targetDocumentId,
        targetId: target.targetId,
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
