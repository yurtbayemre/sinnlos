import type { CourseEditable, EditableMedia, LessonEditable, QuizQuestion } from "@sinnlos/domain";
import { coerceDocumentValues } from "./values";

export interface CourseValues {
  title: string;
  description: string;
  mandatory: boolean;
  completionMode: string;
  coverImage: EditableMedia | null;
}
export interface LessonValues {
  title: string;
  body: string;
  order: string;
  course: string;
  videoUrl: string;
  quiz: QuizQuestion[];
}
export const emptyCourseValues = (): CourseValues => ({
  title: "",
  description: "",
  mandatory: false,
  completionMode: "confirm",
  coverImage: null,
});
export const emptyLessonValues = (course: string): LessonValues => ({
  title: "",
  body: "",
  order: "0",
  course,
  videoUrl: "",
  quiz: [],
});
export const courseValuesFromEditable = (item: CourseEditable): CourseValues => ({
  title: item.title,
  description: item.description ?? "",
  mandatory: item.mandatory,
  completionMode: item.completionMode,
  coverImage: item.coverImage,
});
export const lessonValuesFromEditable = (item: LessonEditable): LessonValues => ({
  title: item.title,
  body: item.body ?? "",
  order: String(item.order),
  course: item.course?.documentId ?? "",
  videoUrl: item.videoUrl ?? "",
  quiz: item.quiz.map((q) => ({ ...q, options: [...q.options] })),
});

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown) => (typeof value === "string" ? value.slice(0, 210_000) : "");
export function coerceCourseValues(raw: unknown): CourseValues {
  const r = record(raw);
  return {
    title: str(r.title),
    description: str(r.description),
    mandatory: r.mandatory === true,
    completionMode: str(r.completionMode),
    coverImage: coerceDocumentValues({ file: r.coverImage }).file,
  };
}
export function coerceLessonValues(raw: unknown): LessonValues {
  const r = record(raw);
  return {
    title: str(r.title),
    body: str(r.body),
    order: str(r.order),
    course: str(r.course),
    videoUrl: str(r.videoUrl),
    // Keep invalid quiz input invalid: the shared validator must refuse it, never turn it into a manual lesson.
    quiz: r.quiz as QuizQuestion[],
  };
}
