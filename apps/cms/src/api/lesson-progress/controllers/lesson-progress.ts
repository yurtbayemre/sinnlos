import { factories } from "@strapi/strapi";

/**
 * Completion receipts follow the acknowledgement integrity pattern
 * (issue #29): the caller can NEVER pick the completing user — it is
 * always taken from ctx.state.user — and duplicates / invalid targets
 * are rejected server-side.
 *
 * Target anchoring — the lesson's documentId, NOT the numeric id:
 * Strapi 5 publishes by DELETE + RE-CREATE, so the published row id
 * changes on every re-publish; a row-id anchor would orphan every
 * user's progress the next time an author hits "Publish" (the exact
 * issue-#11 failure class). The documentId is stable across the whole
 * draft/publish lifecycle.
 */
const LESSON_UID = "api::lesson.lesson";
const PROGRESS_UID = "api::lesson-progress.lesson-progress";

export default factories.createCoreController(PROGRESS_UID, ({ strapi }) => ({
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as any;
    const data = body.data ?? body;
    const targetDocumentId = data?.targetDocumentId;
    if (typeof targetDocumentId !== "string" || targetDocumentId.length === 0) {
      return ctx.badRequest("targetDocumentId required");
    }

    // The lesson must exist PUBLISHED and belong to a PUBLISHED course.
    // Deliberately ONE identical error for all failure modes — "no such
    // lesson", "draft only" and "course unpublished" — so the endpoint
    // is no existence oracle for draft documentIds (§5.17).
    const lesson = await strapi.db.query(LESSON_UID).findOne({
      where: { documentId: targetDocumentId, publishedAt: { $notNull: true } },
      populate: { course: { select: ["id", "publishedAt"] } },
    });
    if (!lesson || !lesson.course?.publishedAt) {
      return ctx.badRequest("Target not available for completion");
    }

    // One receipt per user + lesson. Accepted check-then-insert race
    // (#16 class, same as acknowledgement): a photo-finish duplicate is
    // cosmetic — every consumer dedupes by Set over targetDocumentId,
    // and course completion is a set comparison (inherently idempotent).
    const existing = await strapi.db
      .query(PROGRESS_UID)
      .findOne({ where: { user: user.id, targetDocumentId } });
    if (existing) return ctx.badRequest("Already completed");

    // Single-row db.query create — attaches the user relation correctly
    // (createMany would NOT link relations).
    const progress = await strapi.db.query(PROGRESS_UID).create({
      data: {
        user: user.id,
        targetDocumentId,
        completedAt: new Date().toISOString(),
      },
    });
    return ctx.send({ data: progress });
  },
}));
