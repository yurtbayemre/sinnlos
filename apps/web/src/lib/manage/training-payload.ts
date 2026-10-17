import {
  TRAINING_FIELDS,
  checkRequiredString,
  checkMarkdown,
  checkEnum,
  checkOrder,
  validateQuiz,
  youtubeVideoId,
} from "@sinnlos/domain";
import { isDocumentId } from "@/lib/entry-id";
import {
  checked,
  collectFields,
  done,
  textOrNull,
  type BuiltPayload,
  type FieldRule,
  type PayloadContext,
} from "./payload";
import type { CourseValues, LessonValues } from "./training-values";

const COURSE_RULES: readonly FieldRule<CourseValues>[] = [
  { key: "title", inputs: ["title"], convert: (v) => checked(v.title.trim(), checkRequiredString) },
  {
    key: "description",
    inputs: ["description"],
    convert: (v) => checked(v.description.trim() ? v.description : null, checkMarkdown),
  },
  { key: "mandatory", inputs: ["mandatory"], convert: (v) => ({ value: v.mandatory }) },
  {
    key: "completionMode",
    inputs: ["completionMode"],
    convert: (v) => checked(v.completionMode, checkEnum(["confirm", "quizGate", "exam"])),
  },
  {
    key: "coverImage",
    inputs: ["coverImage"],
    same: (a, b) => (a as CourseValues["coverImage"])?.id === (b as CourseValues["coverImage"])?.id,
    convert: (v) => ({ value: v.coverImage?.id ?? null }),
  },
];
const LESSON_RULES: readonly FieldRule<LessonValues>[] = [
  { key: "title", inputs: ["title"], convert: (v) => checked(v.title.trim(), checkRequiredString) },
  {
    key: "body",
    inputs: ["body"],
    convert: (v) => checked(v.body.trim() ? v.body : null, checkMarkdown),
  },
  {
    key: "order",
    inputs: ["order"],
    convert: (v) =>
      /^\d{1,6}$/.test(v.order.trim()) ? checked(Number(v.order), checkOrder) : { code: "invalid" },
  },
  {
    key: "course",
    inputs: [],
    convert: (v) => (isDocumentId(v.course) ? { value: v.course } : { code: "required" }),
  },
  {
    key: "videoUrl",
    inputs: ["videoUrl"],
    convert: (v) =>
      !v.videoUrl.trim() || youtubeVideoId(v.videoUrl)
        ? { value: textOrNull(v.videoUrl) }
        : { code: "videoUrlNotYoutube" },
  },
  {
    key: "quiz",
    inputs: ["quiz"],
    same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    convert: (v) => {
      if (!Array.isArray(v.quiz)) return { code: "quizInvalid" };
      const result = validateQuiz(v.quiz);
      return "error" in result ? { code: "quizInvalid" } : { value: result.quiz };
    },
  },
];
export function buildCoursePayload(
  values: CourseValues,
  initial: CourseValues | null,
  ctx: PayloadContext,
): BuiltPayload {
  const { data, fields } = collectFields(
    new Set(TRAINING_FIELDS.course.moderator),
    new Set<string>(),
    COURSE_RULES,
    values,
    initial,
    ctx,
  );
  return done(data, fields);
}
export function buildLessonPayload(
  values: LessonValues,
  initial: LessonValues | null,
  ctx: PayloadContext,
): BuiltPayload {
  const { data, fields } = collectFields(
    new Set(TRAINING_FIELDS.lesson.moderator),
    new Set<string>(),
    LESSON_RULES,
    values,
    initial,
    ctx,
  );
  // The nested editor selects a course on create and never reparents an existing lesson.
  if (ctx.mode === "update") delete data.course;
  return done(data, fields);
}
