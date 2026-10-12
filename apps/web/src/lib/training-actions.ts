"use server";

import { refresh } from "next/cache";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { strapi } from "@/lib/strapi";

/**
 * Marks a lesson completed for the caller. Answers an ActionResult (AC01):
 * the cms's 400 for an unknown, draft-only or invisible lesson and for a
 * repeated completion is "invalid".
 */
export async function completeLesson(lessonDocumentId: string): Promise<ActionResult> {
  // A Server Action's argument comes from the client.
  if (typeof lessonDocumentId !== "string" || lessonDocumentId === "") {
    return actionFailure("invalid");
  }
  // The CMS controller takes the completing user from the JWT
  // (ctx.state.user) — the payload only names the lesson, by documentId
  // (stable across re-publishes, unlike the numeric id).
  return runCmsAction(
    () =>
      strapi("/api/lesson-progresses", {
        method: "POST",
        body: JSON.stringify({ data: { targetDocumentId: lessonDocumentId } }),
      }),
    {
      label: "[training] complete lesson",
      // Progress is read uncached (D-DC01) — refresh so the course pages and
      // the dashboard banner reflect the new state without a manual reload.
      after: () => refresh(),
    },
  );
}
