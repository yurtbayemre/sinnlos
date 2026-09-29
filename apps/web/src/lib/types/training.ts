/** Training courses, lessons and progress (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";

/** Training course (issue #29) — admin-authored, native draft & publish. */
export interface Course {
  id: number;
  documentId?: string;
  title: string;
  slug?: string;
  description?: string | null;
  mandatory?: boolean;
  completionMode?: "confirm" | "quizGate";
  coverImage?: { url?: string; formats?: { small?: { url?: string } } | null } | null;
  lessons?: Lesson[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Lesson {
  id: number;
  documentId?: string;
  title: string;
  body?: string | null;
  order?: number | null;
  videoUrl?: string | null;
  /** Raw quiz JSON — parse with parseQuiz() (defensive, admin-authored). */
  quiz?: unknown;
  course?: Course | null;
  updatedAt?: string;
}

/** Completion receipt — anchored on the lesson's documentId. */
export interface LessonProgress {
  id: number;
  documentId?: string;
  targetDocumentId: string;
  completedAt?: string | null;
  user?: UserLite | null;
}
