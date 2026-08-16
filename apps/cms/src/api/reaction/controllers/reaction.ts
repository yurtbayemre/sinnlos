import { factories } from "@strapi/strapi";
import {
  WRITE_TARGET_ERRORS,
  resolveWriteTarget,
  targetMatchWhere,
} from "../../../utils/comment-target";

const REACTION_UID = "api::reaction.reaction";

export default factories.createCoreController(REACTION_UID, ({ strapi }) => ({
  /**
   * Toggle: POST the same emoji twice and the reaction is removed again.
   *
   * The target is anchored by documentId, never by the numeric row id —
   * publishing an announcement/wiki page in Strapi 5 is delete+recreate, so
   * an id-anchored reaction detaches on the next "Publish" (issue #11, see
   * utils/comment-target.ts). Author is server-authoritative (§5.21).
   *
   * TEMPORARY MIGRATION BRIDGE (issue #11, removed by its follow-up ticket
   * together with the `targetId` column): `resolveWriteTarget` also accepts a
   * payload carrying ONLY the deprecated `targetId` (an old web container
   * against this CMS — the partial rollback in infra/deploy.sh) and returns
   * the target's current row id, which is dual-written so a full rollback to
   * the id-only code still sees these reactions.
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
    const { targetType, targetDocumentId, targetId } = target;

    // The legacy branch of `targetMatchWhere` is TEMPORARY (issue #11): it
    // also recognises a reaction of this user that the bootstrap backfill has
    // not anchored yet, so toggling it off still works instead of adding a
    // second row. It is clamped to `targetDocumentId IS NULL`, so the rows
    // this controller writes — which carry BOTH keys — only ever match via
    // the anchor. Remove it together with the targetId column.
    const existing = await strapi.db.query(REACTION_UID).findOne({
      where: {
        ...targetMatchWhere(targetType, targetDocumentId, targetId),
        emoji,
        author: user.id,
      },
    });

    if (existing) {
      await strapi.db.query(REACTION_UID).delete({
        where: { id: existing.id },
      });
      return ctx.send({ data: null, toggled: "removed" });
    }

    // Dual-write, TEMPORARY (issue #11): the anchor plus the target's current
    // row id, so a rollback to the id-only code still finds this reaction.
    ctx.request.body = {
      data: { emoji, targetType, targetDocumentId, targetId, author: user.id },
    };
    return super.create(ctx);
  },
}));
