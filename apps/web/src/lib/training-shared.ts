/** Training display helpers; quiz grading and answer keys stay in the CMS. */
import type { LearnerQuizQuestion } from "@sinnlos/domain";

export { youtubeEmbedUrl, youtubeVideoId } from "@sinnlos/domain";
export type {
  LearnerQuizQuestion,
  TrainingCompletionMode as CompletionMode,
} from "@sinnlos/domain";

/** Sort contract for lessons: order:asc, then id:asc as the stable tiebreak. */
export function sortLessons<T extends { order?: number | null; id: number }>(lessons: T[]): T[] {
  return [...lessons].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

/** Every open quiz lesson waits for server feedback; historical receipts remain valid. */
export function quizGatesCompletion(quiz: LearnerQuizQuestion[], completed: boolean): boolean {
  return !completed && quiz.length > 0;
}
