import type { CourseEditable, EditableMedia, LessonEditable, QuizQuestion } from "@sinnlos/domain";
import { coerceDocumentValues, idList } from "./values";

export interface CourseValues {
  title: string;
  description: string;
  mandatory: boolean;
  completionMode: string;
  /** Months as typed; empty = once is enough. */
  validityMonths: string;
  /** Who answers questions about the course ("Fragen an: …", v0.28); empty = nobody named. */
  contact: string;
  /** Department documentIds; empty = every staff member. */
  departments: string[];
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
  validityMonths: "",
  contact: "",
  departments: [],
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
  validityMonths: item.validityMonths === null ? "" : String(item.validityMonths),
  contact: item.contact ?? "",
  departments: [...item.departments],
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
    validityMonths: str(r.validityMonths).slice(0, 10),
    contact: str(r.contact).slice(0, 1_000),
    departments: idList(r.departments),
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
