import { factories } from "@strapi/strapi";
import {
  WRITE_TARGET_ERRORS,
  resolveWriteTarget,
  targetMatchWhere,
} from "../../../utils/comment-target";
import { parseEntryRef } from "../../../utils/entry-id";
import { emitLiveEvent } from "../../../utils/live-events";
import { isTargetVisible } from "../../../utils/target-visibility";

const REACTION_UID = "api::reaction.reaction";

export default factories.createCoreController(REACTION_UID, ({ strapi }) => ({
  /**
   * Sets or toggles the caller's reaction with one emoji on one target.
   *
   * `reacted` (optional boolean, FX28) is the desired end state, which makes
   * a repeated request harmless (a double click, a retry):
   *   - true:  the reaction exists afterwards; an existing one is returned
   *            unchanged (200), otherwise it is created;
   *   - false: the reaction is gone afterwards; an existing one is deleted,
   *            otherwise nothing happens;
   *   - absent: toggle, as before: POST the same emoji twice and the
   *            reaction is removed again (older web builds).
   *
   * The target is anchored by documentId, never by the numeric row id —
   * publishing an announcement/wiki page in Strapi 5 is delete+recreate, so
   * an id-anchored reaction detaches on the next "Publish" (issue #11, see
   * utils/comment-target.ts). Author is server-authoritative (§5.21).
   * A remove deletes every matching row: concurrent creates can leave
   * duplicates (no unique index, DA04).
   * Only the documentId anchor is accepted (#25 removed the targetId
   * migration bridge): a targetId-only payload is answered with 400.
   *
   * Order: payload guards, then target resolution, then visibility, then
   * the lookup of the existing reaction.
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
    const reacted: unknown = body?.reacted;
    if (reacted !== undefined && typeof reacted !== "boolean") {
      return ctx.badRequest("reacted must be a boolean");
    }

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

    if (existing && reacted === true) {
      // Already in the desired state: answer with the reaction, no write.
      ctx.status = 200;
      return this.transformResponse(await this.sanitizeOutput(existing, ctx));
    }

    if (existing) {
      // Delete EVERY matching row, not just the one found above: reactions
      // have no unique index (DA04), so two concurrent creates can both miss
      // the lookup and insert a duplicate. "false" (and the toggle's remove)
      // must leave none behind. One entity-manager delete per row, not
      // deleteMany: the latter is a bare query-builder delete in
      // @strapi/database 5.55.1 and would leave the author link rows behind.
      const rows: Array<{ id: number }> = await strapi.db.query(REACTION_UID).findMany({
        where: {
          ...targetMatchWhere(targetType, targetDocumentId),
          emoji,
          author: user.id,
        },
        select: ["id"],
      });
      for (const row of rows) {
        await strapi.db.query(REACTION_UID).delete({ where: { id: row.id } });
      }
      // Belt-and-braces alongside the global DB-lifecycle subscriber:
      // whether afterDelete fires for db.query deletes is version-
      // sensitive, and the 100ms emit batch dedupes the channel anyway.
      emitLiveEvent({ kind: "content", targetType, targetDocumentId });
      return ctx.send({ data: null, toggled: "removed" });
    }

    // Already in the desired state (no reaction): nothing to delete.
    if (reacted === false) return ctx.send({ data: null });

    // Rebuilding the data object also implicitly strips a client-sent
    // targetId (no longer a schema attribute) and `reacted`.
    ctx.request.body = {
      data: { emoji, targetType, targetDocumentId, author: user.id },
    };
    return super.create(ctx);
  },

  /**
   * DELETE /api/reactions/:id, behind global::is-reaction-author (author,
   * or admin_role/editor). `:id` is a documentId or a numeric row id (PL01,
   * owner default "translate"): the v5 core controller resolves only
   * documentIds, so a numeric id deleted nothing and still answered 204 —
   * for moderators, whose policy bypass never looks the row up. It is
   * translated here; a malformed id or a missing row answers 404
   * (utils/entry-id.ts).
   */
  async delete(ctx) {
    const where = parseEntryRef(ctx.params.id);
    if (!where) return ctx.notFound();
    const entity = await strapi.db.query(REACTION_UID).findOne({
      where,
      select: ["id", "documentId"],
    });
    if (!entity) return ctx.notFound();
    ctx.params.id = entity.documentId;
    return super.delete(ctx);
  },
}));
