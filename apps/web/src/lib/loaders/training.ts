import {
  courseValidity,
  lessonReceiptState,
  zonedDateKey,
  type CourseValidityStatus,
} from "@sinnlos/domain";
import type { CourseView } from "@/lib/api/training";
import { appTimeZone } from "@/lib/app-time-zone";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourseBySlug, fetchCourses, fetchMyProgress } from "@/lib/training";
import { sortLessons } from "@/lib/training-shared";

/**
 * Training (WD03, issue #29). One overview for the dashboard banner and the
 * course list, and the course page on the same progress read: the status
 * is DERIVED from the caller's own newest receipt per lesson and the
 * course's validity (@sinnlos/domain courseValidity, v0.20), fail-closed:
 * a failed or truncated read makes the status unknown ("–", no banner)
 * instead of a false green or a wrong count. Courses are status- and
 * audience-gated per role by the CMS (drafts stay with the authors),
 * progress is strictly the caller's own.
 */

/** Lesson documentIds of a course outline. */
const lessonIdsOf = (lessons: { documentId?: string | null }[]) =>
  lessons
    .map((l) => l.documentId)
    .filter((id): id is string => typeof id === "string" && id !== "");

/** Today in APP_TIME_ZONE, and the zone. */
function today(): { todayKey: string; timeZone: string } {
  const timeZone = appTimeZone();
  return { todayKey: zonedDateKey(new Date(), timeZone), timeZone };
}

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
  /** Lessons that count today. */
  completed: number;
  /** Every lesson counts (status done or dueSoon); never for a course without lessons. */
  done: boolean;
  status: CourseValidityStatus;
  /** Earliest due day (YYYY-MM-DD) for a course with validity; null otherwise. */
  dueKey: string | null;
}

export interface TrainingOverview {
  courses: CourseOverview[];
  /** The completion cannot be told (a read failed or a walk was cut): "–". */
  statusUnknown: boolean;
  /**
   * Mandatory courses with lessons the caller has not finished or whose
   * completion expired; null when the status is unknown (the dashboard
   * banner then stays away).
   */
  openMandatory: number | null;
  /** Mandatory courses that expire within the renewal window; null when unknown. */
  dueSoonMandatory: number | null;
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
  const { todayKey, timeZone } = today();
  const courses = (coursesResult.data?.courses ?? []).map((course): CourseOverview => {
    const validity = courseValidity(
      lessonIdsOf(course.lessons ?? []),
      progress.completed,
      course.validityMonths,
      todayKey,
      timeZone,
    );
    return {
      course,
      total: validity.total,
      completed: validity.completed,
      done: validity.status === "done" || validity.status === "dueSoon",
      status: validity.status,
      dueKey: validity.dueKey,
    };
  });
  const failed = coursesResult.failed || progress.failed;
  const truncated = !!coursesResult.data?.truncated || progress.truncated;
  const statusUnknown = failed || truncated;

  return {
    courses,
    statusUnknown,
    openMandatory: statusUnknown
      ? null
      : courses.filter((c) => c.course.mandatory && c.total > 0 && !c.done).length,
    dueSoonMandatory: statusUnknown
      ? null
      : courses.filter((c) => c.course.mandatory && c.status === "dueSoon").length,
    empty: !coursesResult.failed && courses.length === 0,
    failed,
    truncated,
  };
}

type CourseLesson = NonNullable<CourseView["lessons"]>[number];

export interface CoursePage {
  course: CourseView;
  /**
   * In course order (order, then id): done = counts today; renew = done
   * before, but due within the renewal window or overdue (complete it again).
   */
  lessons: { lesson: CourseLesson; done: boolean; renew: boolean }[];
  total: number;
  completed: number;
  done: boolean;
  status: CourseValidityStatus;
  dueKey: string | null;
  /** The caller's progress could not be read completely: "–". */
  statusUnknown: boolean;
  /** The first lesson to (re)complete (the "continue" link); null: none. */
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
  const { todayKey, timeZone } = today();
  const states = lessons.map((lesson) => {
    const id = lesson.documentId ?? "";
    const has = id !== "" && progress.completed.has(id);
    const state = lessonReceiptState(
      progress.completed.get(id),
      has,
      course.validityMonths,
      todayKey,
      timeZone,
    );
    return { lesson, done: id !== "" && state.counts, renew: has && state.mayComplete };
  });
  const validity = courseValidity(
    lessonIdsOf(lessons),
    progress.completed,
    course.validityMonths,
    todayKey,
    timeZone,
  );
  return {
    course,
    lessons: states,
    total: validity.total,
    completed: validity.completed,
    done: validity.status === "done" || validity.status === "dueSoon",
    status: validity.status,
    dueKey: validity.dueKey,
    statusUnknown: progress.failed || progress.truncated,
    firstOpen: states.find((s) => !!s.lesson.documentId && (!s.done || s.renew))?.lesson ?? null,
  };
}
