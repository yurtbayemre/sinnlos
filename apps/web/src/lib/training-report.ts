import { courseCompletion, sortLessons } from "@/lib/training-shared";
import type { Course, Lesson, LessonProgress } from "@/lib/types";

/**
 * Completion report per mandatory course for /manage/training (issue #29;
 * WD02: moved out of app/(app)/manage/training/page.tsx, the fetches stay
 * in the page and lib/training.ts). Fail-closed: any truncated or failed
 * input suppresses the numbers ("–"), never a false green.
 */

export interface TrainingReportUser {
  id: number;
  role?: { id?: number; type?: string } | null;
  blocked?: boolean;
}

/**
 * Unblocked users of a training role: the report's denominator. The page
 * passes its TRAINING_ROLES (the role types holding course.find;
 * infra/contracts.test.ts pins that page-local copy against the CMS matrix
 * until SH02 moves it).
 */
export function trainingStaff<U extends TrainingReportUser>(
  users: U[],
  trainingRoles: ReadonlySet<string>,
): U[] {
  return users.filter((u) => u.blocked !== true && trainingRoles.has(u.role?.type ?? ""));
}

/** A course's CURRENT lessons in display order, and their documentIds. */
export function courseLessons(course: Course): { lessons: Lesson[]; lessonIds: string[] } {
  const lessons = sortLessons(course.lessons ?? []);
  const lessonIds = lessons
    .map((l) => l.documentId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  return { lessons, lessonIds };
}

/** One course's progress walk: its rows, or null when the fetch failed. */
export type CourseProgress = { rows: LessonProgress[]; truncated: boolean } | null;

export interface TrainingReportRow {
  course: Course;
  lessonCount: number;
  /** Users who completed every current lesson; null when unknown (fetch failed). */
  completedUsers: number | null;
  /** This course's own progress walk was cut short (or failed). */
  truncated: boolean;
  /** No number may be shown for this row: render "–". */
  unknown: boolean;
  /** Completion rate in whole percent; null when unknown or nobody is counted. */
  pct: number | null;
}

export interface TrainingReport {
  rows: TrainingReportRow[];
  /** Any input walk was cut short or failed: warn, and show no row's numbers. */
  anyTruncated: boolean;
  /** Users counted per course (trainingStaff). */
  denominator: number;
}

/** Users of `staff` who completed every lesson in `lessons`. */
export function countCompletedUsers(
  lessons: Lesson[],
  rows: LessonProgress[],
  staff: { id: number }[],
): number {
  // userId → set of completed lesson ids; a user counts as done when the
  // set covers the course's CURRENT lessons (same derivation as the learner
  // UI — inherently idempotent against duplicate rows).
  const byUser = new Map<number, Set<string>>();
  for (const row of rows) {
    const uid = row.user?.id;
    if (typeof uid !== "number" || typeof row.targetDocumentId !== "string") continue;
    if (!byUser.has(uid)) byUser.set(uid, new Set());
    byUser.get(uid)!.add(row.targetDocumentId);
  }
  let completedUsers = 0;
  for (const u of staff) {
    const set = byUser.get(u.id) ?? new Set<string>();
    if (courseCompletion(lessons, set).done) completedUsers++;
  }
  return completedUsers;
}

/**
 * Build the report. `progressOf(course)` returns the course's progress walk
 * (only asked for courses with at least one lesson). A course without
 * lessons reports 0 completions (courseCompletion never counts a 0-lesson
 * course as done). A failed walk makes its row unknown; any truncated input
 * (courses, users, any course's progress) makes EVERY row unknown.
 */
export function trainingReport(input: {
  courses: Course[];
  coursesTruncated: boolean;
  staff: { id: number }[];
  usersTruncated: boolean;
  progressOf: (course: Course) => CourseProgress;
}): TrainingReport {
  const { courses, coursesTruncated, staff, usersTruncated, progressOf } = input;
  const partial = courses.map((course) => {
    const { lessons, lessonIds } = courseLessons(course);
    if (lessonIds.length === 0) {
      return { course, lessonCount: 0, completedUsers: 0, truncated: false };
    }
    const progress = progressOf(course);
    if (progress === null) {
      return { course, lessonCount: lessonIds.length, completedUsers: null, truncated: true };
    }
    return {
      course,
      lessonCount: lessonIds.length,
      completedUsers: countCompletedUsers(lessons, progress.rows, staff),
      truncated: progress.truncated,
    };
  });

  const anyTruncated = coursesTruncated || usersTruncated || partial.some((r) => r.truncated);
  const denominator = staff.length;
  const rows = partial.map((row) => {
    const unknown = row.truncated || row.completedUsers === null || anyTruncated;
    const pct =
      !unknown && denominator > 0
        ? Math.round(((row.completedUsers as number) / denominator) * 100)
        : null;
    return { ...row, unknown, pct };
  });
  return { rows, anyTruncated, denominator };
}
