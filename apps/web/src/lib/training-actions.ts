"use server";

import { refresh } from "next/cache";
import {
  QUIZ_CONTENT_INVALID,
  TRAINING_VERSION_CHANGED,
  isDocumentId,
  isQuizSelectionList,
  type QuizCheckRequest,
  type QuizCheckResponse,
  type QuizSelection,
  type TrainingVersion,
} from "@sinnlos/domain";
import {
  actionFailure,
  runCmsAction,
  type ActionResult,
  type CmsErrorInfo,
} from "@/lib/action-result";
import { strapi } from "@/lib/strapi";

/** The cms's 400 for a quiz lesson completed without the correct answers (issue #70). */
const QUIZ_REFUSAL = "Quiz not passed";

export type TrainingActionError =
  "quizFailed" | typeof QUIZ_CONTENT_INVALID | typeof TRAINING_VERSION_CHANGED;

/** The most answers a completion carries (a bound on the client's input, not on quizzes). */
const MAX_ANSWERS = 100;

/** Answers as the cms takes them: one option index (a small non-negative integer) per question. */
function isAnswerList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ANSWERS &&
    value.every((answer) => Number.isInteger(answer) && answer >= 0 && answer < MAX_ANSWERS)
  );
}

/** The player's version as the cms takes it back: two non-empty ISO strings. */
function isVersion(value: unknown): value is TrainingVersion {
  const v = value as TrainingVersion | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.course === "string" &&
    typeof v.lesson === "string" &&
    v.course.length > 0 &&
    v.course.length <= 64 &&
    v.lesson.length > 0 &&
    v.lesson.length <= 64
  );
}

/**
 * Marks a lesson completed for the caller. Answers an ActionResult (AC01):
 * the cms's 400 for an unknown, draft-only or invisible lesson and for a
 * repeated completion is "invalid"; for a quiz lesson whose `answers` are
 * not all correct (the cms checks them, issue #70) "quizFailed".
 *
 * `answers`: the passing answers of the lesson's quiz, one option index per
 * question as the player shows them; null or left out for a lesson without
 * a quiz.
 *
 * `version`: the player's `data.version` (v0.28), sent back as it came: the
 * cms answers 409 "changed" when an author published the lesson or the
 * course again since the page was rendered, and stores nothing.
 */
export async function completeLesson(
  lessonDocumentId: string,
  answers: number[] | null,
  version: TrainingVersion,
): Promise<ActionResult<TrainingActionError>> {
  // A Server Action's arguments come from the client.
  if (typeof lessonDocumentId !== "string" || lessonDocumentId === "") {
    return actionFailure("invalid");
  }
  if (answers !== null && !isAnswerList(answers)) return actionFailure("invalid");
  if (!isVersion(version)) return actionFailure("invalid");
  // The CMS controller takes the completing user from the JWT
  // (ctx.state.user) — the payload names the lesson, by documentId
  // (stable across re-publishes, unlike the numeric id), and the answers.
  return runCmsAction(
    () =>
      strapi("/api/lesson-progresses", {
        method: "POST",
        body: JSON.stringify({
          data: {
            targetDocumentId: lessonDocumentId,
            ...(answers ? { answers } : {}),
            version: { course: version.course, lesson: version.lesson },
          },
        }),
      }),
    {
      label: "[training] complete lesson",
      mapError: trainingError,
      // Progress is read uncached (D-DC01) — refresh so the course pages and
      // the dashboard banner reflect the new state without a manual reload.
      after: () => refresh(),
    },
  );
}

function trainingError(cms: CmsErrorInfo): TrainingActionError | undefined {
  if (cms.status === 409 && cms.details?.code === TRAINING_VERSION_CHANGED) {
    return TRAINING_VERSION_CHANGED;
  }
  if (cms.status !== 400) return undefined;
  if (cms.details?.code === QUIZ_CONTENT_INVALID) return QUIZ_CONTENT_INVALID;
  return cms.message === QUIZ_REFUSAL ? "quizFailed" : undefined;
}

/** Feedback only: no completion receipt and no refresh after a successful check. */
export async function checkLesson(
  lessonDocumentId: string,
  answers: QuizSelection[],
): Promise<ActionResult<TrainingActionError, QuizCheckResponse["data"]>> {
  if (!isDocumentId(lessonDocumentId) || !isQuizSelectionList(answers)) {
    return actionFailure("invalid");
  }
  const body: QuizCheckRequest = { data: { answers } };
  return runCmsAction(
    () =>
      strapi<QuizCheckResponse>(`/api/lessons/${encodeURIComponent(lessonDocumentId)}/check`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    {
      label: "[training] check lesson",
      mapError: (cms) =>
        cms.status === 400 && cms.message === "Invalid quiz answers"
          ? "quizFailed"
          : trainingError(cms),
      data: (response) => response.data,
    },
  );
}
