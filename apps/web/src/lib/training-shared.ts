/**
 * Pure training helpers (issue #29). The YouTube parser and the quiz schema
 * come from @sinnlos/domain (SH01, packages/domain/src/training.ts), shared
 * with the cms lesson lifecycle (the author-feedback layer). THIS side (the
 * <LessonVideo> render gate) is the AUTHORITATIVE XSS layer: the stored
 * string is never rendered; the embed URL is rebuilt from the extracted id.
 * The course/lesson helpers below are the web's own.
 */
import type { QuizQuestion } from "@sinnlos/domain";

export { parseQuiz, youtubeEmbedUrl, youtubeVideoId, type QuizQuestion } from "@sinnlos/domain";

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

export type CompletionMode = "confirm" | "quizGate";

export interface QuizEvaluation {
  /** Question indexes answered wrongly (empty = all correct). */
  wrong: number[];
  /** True when every question has an answer AND all are correct. */
  passed: boolean;
  answeredAll: boolean;
}

/**
 * Batch evaluation for the quiz-gate flow (pure, tested): answers map
 * question index → picked option index. Unanswered questions count as
 * not passed but not as "wrong" (the UI nudges for completeness first).
 * An empty quiz passes trivially — a quizGate course whose lesson has
 * no (or malformed → dropped) quiz must not dead-lock completion;
 * content errors fail open by design.
 */
export function evaluateQuiz(
  quiz: QuizQuestion[],
  answers: Record<number, number | undefined>,
): QuizEvaluation {
  const wrong: number[] = [];
  let answered = 0;
  quiz.forEach((q, i) => {
    const picked = answers[i];
    if (picked === undefined) return;
    answered++;
    if (picked !== q.correctIndex) wrong.push(i);
  });
  const answeredAll = answered === quiz.length;
  return { wrong, answeredAll, passed: answeredAll && wrong.length === 0 };
}
