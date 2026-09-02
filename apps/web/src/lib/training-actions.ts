"use server";

import { refresh } from "next/cache";
import { strapi } from "@/lib/strapi";

export async function completeLesson(lessonDocumentId: string) {
  // The CMS controller takes the completing user from the JWT
  // (ctx.state.user) — the payload only names the lesson, by documentId
  // (stable across re-publishes, unlike the numeric id).
  await strapi("/api/lesson-progresses", {
    method: "POST",
    body: JSON.stringify({ data: { targetDocumentId: lessonDocumentId } }),
    noCache: true,
  });
  // Progress is fetched with noCache — refresh so the course pages and
  // the dashboard banner reflect the new state without a manual reload.
  refresh();
}
