import { factories } from "@strapi/strapi";
import {
  WRITE_TARGET_ERRORS,
  resolveWriteTarget,
  targetMatchWhere,
} from "../../../utils/comment-target";
import { emitLiveEvent } from "../../../utils/live-events";
import { isTargetVisible } from "../../../utils/target-visibility";

const REACTION_UID = "api::reaction.reaction";

export default factories.createCoreController(REACTION_UID, ({ strapi }) => ({
  /**
   * Toggle: POST the same emoji twice and the reaction is removed again.
   *
   * The target is anchored by documentId, never by the numeric row id —
   * publishing an announcement/wiki page in Strapi 5 is delete+recreate, so
   * an id-anchored reaction detaches on the next "Publish" (issue #11, see
   * utils/comment-target.ts). Author is server-authoritative (§5.21).
   * Only the documentId anchor is accepted (#25 removed the targetId
   * migration bridge): a targetId-only payload is answered with 400.
   */
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = ((ctx.request.body as any)?.data ?? ctx.request.body) as any;
    const { emoji } = body ?? {};
    // Guard the toggle lookup below: an undefined `emoji` would drop out of
    // the where clause and delete an arbitrary reaction of this user on this
    // target. The enum itself is still validated by the core create. Checked
    // before the target lookup so a malformed payload costs no query.
    if (typeof emoji !== "string" || emoji === "") return ctx.badRequest("emoji required");

    const target = await resolveWriteTarget(strapi, body);
    if (target.status === "rejected") return ctx.badRequest(WRITE_TARGET_ERRORS[target.reason]);
    const { targetType, targetDocumentId } = target;

    // #28: an existing-but-invisible target answers with the EXACT same
    // 400 as a nonexistent one (§5.17, no existence oracle). Checked
    // before the toggle lookup so an out-of-audience caller can neither
    // add NOR remove a reaction in a hidden discussion.
    const visible = await isTargetVisible(strapi, targetType, targetDocumentId, ctx.state.user);
    if (!visible) return ctx.badRequest(WRITE_TARGET_ERRORS["unresolved-target"]);

    // Toggle lookup by the anchor pair only. Behaviour change with #25: a
    // reaction row WITHOUT an anchor (targetDocumentId IS NULL) can no longer
    // be toggled off — per §7b the #11 backfill left 0 unresolvable rows, so
    // no such row exists.
    const existing = await strapi.db.query(REACTION_UID).findOne({
      where: {
        ...targetMatchWhere(targetType, targetDocumentId),
        emoji,
        author: user.id,
      },
    });

    if (existing) {
      await strapi.db.query(REACTION_UID).delete({
        where: { id: existing.id },
      });
      // Belt-and-braces alongside the global DB-lifecycle subscriber:
      // whether afterDelete fires for db.query deletes is version-
      // sensitive, and the 100ms emit batch dedupes the channel anyway.
      emitLiveEvent({ kind: "content", targetType, targetDocumentId });
      return ctx.send({ data: null, toggled: "removed" });
    }

    // Rebuilding the data object also implicitly strips a client-sent
    // targetId — it is no longer a schema attribute.
    ctx.request.body = {
      data: { emoji, targetType, targetDocumentId, author: user.id },
    };
    return super.create(ctx);
  },
}));
