/** Training display helpers; quiz grading and answer keys stay in the CMS. */
import type { LearnerQuizQuestion } from "@sinnlos/domain";

export { youtubeEmbedUrl, youtubeVideoId } from "@sinnlos/domain";
export type {
  LearnerQuizQuestion,
  TrainingCompletionMode as CompletionMode,
} from "@sinnlos/domain";

export interface CourseLessonRef {
  documentId?: string | null;
}

/**
 * Course completion is DERIVED at read time — never materialized: the
 * set of the user's completed lesson documentIds must cover the course's
 * CURRENT lesson list. Inherently idempotent against duplicate progress
 * rows (#16 race class) and a lesson added later automatically re-opens
 * the course for everyone (confirmed product decision).
 * Fail-closed: a course with zero lessons is never "completed".
 */
export function courseCompletion(
  lessons: CourseLessonRef[],
  completedDocumentIds: Set<string>,
): { total: number; completed: number; done: boolean } {
  const ids = lessons
    .map((l) => l.documentId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  const completed = ids.filter((id) => completedDocumentIds.has(id)).length;
  return { total: ids.length, completed, done: ids.length > 0 && completed === ids.length };
}

/** Sort contract for lessons: order:asc, then id:asc as the stable tiebreak. */
export function sortLessons<T extends { order?: number | null; id: number }>(lessons: T[]): T[] {
  return [...lessons].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

/** Every open quiz lesson waits for server feedback; historical receipts remain valid. */
export function quizGatesCompletion(quiz: LearnerQuizQuestion[], completed: boolean): boolean {
  return !completed && quiz.length > 0;
}
