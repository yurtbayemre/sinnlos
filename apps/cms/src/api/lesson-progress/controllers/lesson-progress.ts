import { factories } from "@strapi/strapi";
import {
  QUIZ_CONTENT_INVALID,
  TRAINING_VERSION_CHANGED,
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_QUESTIONS,
  lessonReceiptState,
  newestReceipts,
  quizAnswersPass,
} from "@sinnlos/domain";

import { appTimeZone, todayIn } from "../../../utils/time";
import { loadPublishedLesson } from "../../../utils/training-access";
import {
  isSameVersion,
  snapshotAtCompletion,
  trainingVersionOf,
} from "../../../utils/training-evidence";
import { toIso } from "../../../utils/training-roster";
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
 *
 * Renewal (v0.20): a course with `validityMonths` takes a NEW receipt once
 * the newest one is due within RENEWAL_WINDOW_DAYS or overdue
 * (lessonReceiptState); receipts are never edited, the old ones stay as the
 * proof history.
 *
 * Evidence (v0.28, utils/training-evidence.ts): the completion carries the
 * published versions the player showed (`data.version`); a lesson or course
 * published again meanwhile, or no version at all, answers 409 `changed`
 * (reload, then complete), so the receipt's snapshot names what the learner
 * saw: course, lesson, versions, quiz outcome, validity and the learner.
 */
const PROGRESS_UID = "api::lesson-progress.lesson-progress";
const USER_UID = "plugin::users-permissions.user";

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
    const lesson = await loadPublishedLesson(strapi, targetDocumentId, user);
    if (!lesson) return ctx.badRequest("Target not available for completion");
    const validated = validateStoredQuiz(lesson.quiz);
    if ("error" in validated) {
      return ctx.badRequest("Invalid quiz content", { code: QUIZ_CONTENT_INVALID });
    }

    const version = trainingVersionOf(lesson);
    if (!version || !isSameVersion(data.version, version)) {
      ctx.status = 409;
      ctx.body = {
        data: null,
        error: {
          status: 409,
          name: "ConflictError",
          message: "The lesson was published again; reload it",
          details: { code: TRAINING_VERSION_CHANGED },
        },
      };
      return;
    }

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

    // One receipt per user + lesson while it counts (renewal: see the
    // header). Accepted check-then-insert race (#16 class, same as
    // acknowledgement): a photo-finish duplicate is cosmetic — every
    // consumer keeps the newest receipt per lesson (newestReceipts).
    const previous = await strapi.db
      .query(PROGRESS_UID)
      .findMany({ where: { user: user.id, targetDocumentId }, select: ["id", "completedAt"] });
    if (Array.isArray(previous) && previous.length > 0) {
      const newest = newestReceipts(
        previous.map((row: { completedAt?: unknown }) => ({
          targetDocumentId,
          completedAt: toIso(row.completedAt),
        })),
      ).get(targetDocumentId);
      const zone = appTimeZone();
      const state = lessonReceiptState(
        newest,
        true,
        lesson.course.validityMonths,
        todayIn(zone).toString(),
        zone,
      );
      if (!state.mayComplete) return ctx.badRequest("Already completed");
    }

    // Single-row db.query create — attaches the user relation correctly
    // (createMany would NOT link relations).
    const completedAt = new Date().toISOString();
    const learner = await strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      select: ["id", "username", "displayName", "email", "anonymisedAt"],
    });
    const progress = await strapi.db.query(PROGRESS_UID).create({
      data: {
        user: user.id,
        targetDocumentId,
        completedAt,
        snapshot: snapshotAtCompletion({
          lesson,
          version,
          quizPassed: validated.quiz.length > 0,
          learner,
          completedAt,
          timeZone: appTimeZone(),
        }),
      },
    });
    // The snapshot is the evidence's, not the learner's answer (schema-private).
    delete (progress as { snapshot?: unknown }).snapshot;
    return ctx.send({ data: progress });
  },
}));
