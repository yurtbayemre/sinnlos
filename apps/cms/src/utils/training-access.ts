import type { Core } from "@strapi/strapi";
import { isDocumentId, type TrainingCompletionMode } from "@sinnlos/domain";

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
    publishedAt: unknown;
  };
}

/** One published target check for player, feedback and completion, including moderators. */
export async function loadPublishedLesson(
  strapi: Pick<Core.Strapi, "db">,
  documentId: unknown,
): Promise<PublishedLesson | null> {
  if (!isDocumentId(documentId)) return null;
  const lesson = await strapi.db.query("api::lesson.lesson").findOne({
    where: { documentId, publishedAt: { $notNull: true } },
    select: ["documentId", "title", "body", "order", "videoUrl", "quiz"],
    populate: {
      course: { select: ["documentId", "title", "slug", "completionMode", "publishedAt"] },
    },
  });
  // shortcut: availability can race with publish/reparent; add serialization if alpha needs it.
  return lesson?.course?.publishedAt ? (lesson as PublishedLesson) : null;
}
