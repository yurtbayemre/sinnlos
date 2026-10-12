import type { CourseView } from "@/lib/api/training";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourseBySlug, fetchCourses, fetchMyProgress } from "@/lib/training";
import { courseCompletion, sortLessons } from "@/lib/training-shared";

/**
 * Training (WD03, issue #29). One overview for the dashboard banner and the
 * course list, and the course page on the same progress read: completion
 * is DERIVED from the caller's own progress rows (lib/training-shared.ts
 * courseCompletion), fail-closed: a failed or truncated read makes the
 * status unknown ("–", no banner) instead of a false green or a wrong
 * count. Courses are status-gated per role by the CMS (drafts stay with
 * the authors), progress is strictly the caller's own.
 */

/** The caller's completion receipts: lesson documentId → completedAt. */
export interface MyTrainingProgress {
  completed: ReadonlyMap<string, string | null>;
  failed: boolean;
  truncated: boolean;
}

/** The caller's progress (one walk), shared by the overview and the course page. */
export async function loadMyTrainingProgress(label: string): Promise<MyTrainingProgress> {
  const result = await tryFetch(() => fetchMyProgress(), label);
  return {
    completed: result.data?.completed ?? new Map(),
    failed: result.failed,
    // No data: the walk did not finish, so nothing is known.
    truncated: result.data?.truncated ?? !result.failed,
  };
}

/** One course card with the caller's completion. */
export interface CourseOverview {
  course: CourseView;
  /** Lessons with a documentId (the course's current outline). */
  total: number;
  completed: number;
  /** All lessons done; never for a course without lessons. */
  done: boolean;
}

export interface TrainingOverview {
  courses: CourseOverview[];
  /** The completion cannot be told (a read failed or a walk was cut): "–". */
  statusUnknown: boolean;
  /**
   * Mandatory courses with lessons the caller has not finished; null when
   * the status is unknown (the dashboard banner then stays away).
   */
  openMandatory: number | null;
  /** The courses read answered with none: the empty state (not on an outage). */
  empty: boolean;
  /** A read failed: the CMS-down banner on the list. */
  failed: boolean;
  /** A walk (courses or progress) stopped at its cap. */
  truncated: boolean;
}

/** The courses and the caller's progress: the dashboard banner and /training. */
export async function loadTrainingOverview(label = "training"): Promise<TrainingOverview> {
  const [coursesResult, progress] = await Promise.all([
    tryFetch(() => fetchCourses(), label),
    loadMyTrainingProgress(label),
  ]);
  const doneIds = new Set(progress.completed.keys());
  const courses = (coursesResult.data?.courses ?? []).map((course) => ({
    course,
    ...courseCompletion(course.lessons ?? [], doneIds),
  }));
  const failed = coursesResult.failed || progress.failed;
  const truncated = !!coursesResult.data?.truncated || progress.truncated;
  const statusUnknown = failed || truncated;

  return {
    courses,
    statusUnknown,
    openMandatory: statusUnknown
      ? null
      : courses.filter((c) => c.course.mandatory && c.total > 0 && !c.done).length,
    empty: !coursesResult.failed && courses.length === 0,
    failed,
    truncated,
  };
}

type CourseLesson = NonNullable<CourseView["lessons"]>[number];

export interface CoursePage {
  course: CourseView;
  /** In course order (order, then id), each with the caller's completion. */
  lessons: { lesson: CourseLesson; done: boolean }[];
  total: number;
  completed: number;
  done: boolean;
  /** The caller's progress could not be read completely: "–". */
  statusUnknown: boolean;
  /** The first lesson not completed yet (the "continue" link); null: none. */
  firstOpen: CourseLesson | null;
}

/**
 * The course page. Detail-page error strategy (WD07): an unknown course is
 * null (the page answers 404), a failed course read THROWS to
 * (app)/error.tsx; the caller's progress is secondary (status "–").
 */
export async function loadCourse(slug: string): Promise<CoursePage | null> {
  const [course, progress] = await Promise.all([
    fetchCourseBySlug(slug),
    loadMyTrainingProgress("training"),
  ]);
  if (!course) return null;

  const lessons = sortLessons(course.lessons ?? []);
  const doneIds = new Set(progress.completed.keys());
  const isDone = (l: CourseLesson) => !!l.documentId && doneIds.has(l.documentId);
  return {
    course,
    lessons: lessons.map((lesson) => ({ lesson, done: isDone(lesson) })),
    ...courseCompletion(lessons, doneIds),
    statusUnknown: progress.failed || progress.truncated,
    firstOpen: lessons.find((l) => !!l.documentId && !isDone(l)) ?? null,
  };
}
