import { factories } from "@strapi/strapi";
import {
  QUIZ_CONTENT_INVALID,
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_QUESTIONS,
  quizAnswersPass,
} from "@sinnlos/domain";

import { loadPublishedLesson } from "../../../utils/training-access";
import { validateStoredQuiz } from "../../../utils/training-validation";

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
 *
 * Quiz lessons (issue #70): a lesson with questions completes only with
 * `answers`, one option index per question, every one correct
 * (quizAnswersPass, whatever the course's completionMode). The web gates
 * its button on server feedback; completion independently regrades.
 */
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
    const lesson = await loadPublishedLesson(strapi, targetDocumentId);
    if (!lesson) return ctx.badRequest("Target not available for completion");
    const validated = validateStoredQuiz(lesson.quiz);
    if ("error" in validated) {
      return ctx.badRequest("Invalid quiz content", { code: QUIZ_CONTENT_INVALID });
    }

    // shortcut: no displayed-version binding; add version tokens if exam snapshots become required.
    const answers = data.answers;
    const bounded =
      answers === undefined ||
      (Array.isArray(answers) &&
        answers.length <= QUIZ_MAX_QUESTIONS &&
        answers.every(
          (answer) => Number.isInteger(answer) && answer >= 0 && answer < QUIZ_MAX_OPTIONS,
        ));
    if (!bounded || !quizAnswersPass(validated.quiz, answers)) {
      // The web maps this exact text (lib/training-actions.ts).
      return ctx.badRequest("Quiz not passed");
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
