import type { Core } from "@strapi/strapi";
import {
  isDocumentId,
  isInScopedAudience,
  type RoleHolder,
  type TrainingCompletionMode,
} from "@sinnlos/domain";

import { MODERATORS, hasRole } from "../bootstrap/roles";
import { callerDepartmentId } from "./policy-factories";

interface PublishedLesson {
  documentId: string;
  title: string;
  body: string | null;
  order: number;
  videoUrl: string | null;
  quiz: unknown;
  course: {
    documentId: string;
    title: string;
    slug: string;
    completionMode: TrainingCompletionMode | null;
    validityMonths: number | null;
    publishedAt: unknown;
  };
}

/**
 * One published target check for player, feedback and completion: the lesson
 * and its course are published, and the course is meant for the caller
 * (course audience, v0.20: the training-visibility rule for one row;
 * moderators see every course).
 */
export async function loadPublishedLesson(
  strapi: Pick<Core.Strapi, "db">,
  documentId: unknown,
  user: (RoleHolder & { id: number }) | null | undefined,
): Promise<PublishedLesson | null> {
  if (!isDocumentId(documentId) || !user) return null;
  const lesson = await strapi.db.query("api::lesson.lesson").findOne({
    where: { documentId, publishedAt: { $notNull: true } },
    select: ["documentId", "title", "body", "order", "videoUrl", "quiz"],
    populate: {
      course: {
        select: [
          "documentId",
          "title",
          "slug",
          "completionMode",
          "validityMonths",
          "publishedAt",
          "audience",
        ],
        populate: { departments: { select: ["id"] } },
      },
    },
  });
  // shortcut: availability can race with publish/reparent; add serialization if alpha needs it.
  if (!lesson?.course?.publishedAt) return null;
  if (
    !hasRole(user, MODERATORS) &&
    !isInScopedAudience(lesson.course, await callerDepartmentId(strapi, user))
  ) {
    return null;
  }
  return lesson as PublishedLesson;
}
