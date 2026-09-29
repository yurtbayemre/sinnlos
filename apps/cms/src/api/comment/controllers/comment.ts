import { factories } from "@strapi/strapi";
import { WRITE_TARGET_ERRORS, resolveWriteTarget } from "../../../utils/comment-target";
import { findByRef } from "../../../utils/policy-factories";
import { isTargetVisible } from "../../../utils/target-visibility";

const COMMENT_UID = "api::comment.comment";

export default factories.createCoreController(COMMENT_UID, ({ strapi }) => ({
  /**
   * Author is server-authoritative (§5.21) and the target is anchored by
   * documentId, never by the numeric row id: publishing an announcement in
   * Strapi 5 is delete+recreate, so an id-anchored comment detaches on the
   * next "Publish" (issue #11, see utils/comment-target.ts).
   *
   * Only the documentId anchor is accepted (#25 removed the targetId
   * migration bridge): a payload carrying nothing but the legacy `targetId`
   * is answered with 400 "targetDocumentId required".
   *
   * The payload is BUILT from `body` plus the resolved anchor, never
   * forwarded (FX04). The schema still carries `parent`/`replies` (removing
   * them leaves orphan columns anyway with forceMigration=false, §5.27), and
   * both accept raw ids: a member could point a new comment's `parent` at a
   * hidden comment and read it back via `populate[parent]`, bypassing the
   * #28 read filter. Any other client key (author, legacy targetId, ...) is
   * dropped the same way.
   */
  async create(ctx) {
    ctx.request.body = ctx.request.body ?? {};
    const body = ctx.request.body as any;
    const data = body.data ?? body;

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
        body: data?.body,
        targetType: target.targetType,
        targetDocumentId: target.targetDocumentId,
        author: ctx.state.user?.id,
      },
    };
    return super.create(ctx);
  },

  /**
   * DELETE /api/comments/:id, behind global::is-comment-author (author, or
   * admin_role/editor; PL03). The policy decides who may delete; this keeps
   * the id handling. The web addresses comments by numeric id, direct API
   * consumers by documentId, and the v5 core delete resolves documentIds
   * only (a numeric id deleted nothing and still answered 204), so a
   * numeric id is translated here. A malformed, out-of-range or unknown id
   * answers 404 without reaching the query (findByRef, utils/entry-id.ts: a
   * malformed row id was a 500 on Postgres); the policy passes such an id
   * on to this 404, exactly the answer the controller gave before PL03.
   */
  async delete(ctx) {
    const entity = await findByRef(strapi, COMMENT_UID, ctx.params.id, { select: [] });
    if (!entity) return ctx.notFound();
    ctx.params.id = entity.documentId;
    return super.delete(ctx);
  },
}));
