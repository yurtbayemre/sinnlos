"use server";

import { refresh } from "next/cache";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { strapi } from "@/lib/strapi";

/** The cms's 400 for a quiz lesson completed without the correct answers (issue #70). */
const QUIZ_REFUSAL = "Quiz not passed";

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

/**
 * Marks a lesson completed for the caller. Answers an ActionResult (AC01):
 * the cms's 400 for an unknown, draft-only or invisible lesson and for a
 * repeated completion is "invalid"; for a quiz lesson whose `answers` are
 * not all correct (the cms checks them, issue #70) "quizFailed".
 *
 * `answers`: the passing answers of the lesson's quiz, one option index per
 * question as the player shows them; null or left out for a lesson without
 * a quiz.
 */
export async function completeLesson(
  lessonDocumentId: string,
  answers: number[] | null = null,
): Promise<ActionResult<"quizFailed">> {
  // A Server Action's arguments come from the client.
  if (typeof lessonDocumentId !== "string" || lessonDocumentId === "") {
    return actionFailure("invalid");
  }
  if (answers !== null && !isAnswerList(answers)) return actionFailure("invalid");
  // The CMS controller takes the completing user from the JWT
  // (ctx.state.user) — the payload names the lesson, by documentId
  // (stable across re-publishes, unlike the numeric id), and the answers.
  return runCmsAction(
    () =>
      strapi("/api/lesson-progresses", {
        method: "POST",
        body: JSON.stringify({
          data: { targetDocumentId: lessonDocumentId, ...(answers ? { answers } : {}) },
        }),
      }),
    {
      label: "[training] complete lesson",
      mapError: (cms) =>
        cms.status === 400 && cms.message === QUIZ_REFUSAL ? "quizFailed" : undefined,
      // Progress is read uncached (D-DC01) — refresh so the course pages and
      // the dashboard banner reflect the new state without a manual reload.
      after: () => refresh(),
    },
  );
}
