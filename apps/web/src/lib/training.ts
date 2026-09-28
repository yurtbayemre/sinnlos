import {
  courseBySlug,
  courseProgressPage,
  coursesPage,
  lessonByDocumentId,
  myProgressPage,
  type CourseView,
  type LessonView,
  type MyProgressRow,
  type ProgressReportRow,
} from "@/lib/api/training";
import { walkAllPages, type WalkResult } from "@/lib/paginate";

/**
 * Training data helpers (issue #29): the page walks, their caps and the
 * result shaping; each request is one function of lib/api/training.ts
 * (WD01). Every response is per-user: courses and lessons are status-gated
 * per role (admin/editor see drafts) and progress is strictly the caller's
 * own. Uncached like every strapi() read (D-DC01).
 */

export async function fetchCourses(): Promise<{ courses: CourseView[]; truncated: boolean }> {
  const result: WalkResult<CourseView> = await walkAllPages<CourseView>(coursesPage, {
    maxPages: 20,
    label: "courses",
  });
  return { courses: result.data, truncated: result.truncated };
}

export async function fetchCourseBySlug(slug: string): Promise<CourseView | null> {
  const res = await courseBySlug(slug);
  return res.data?.[0] ?? null;
}

export async function fetchLessonByDocumentId(documentId: string): Promise<LessonView | null> {
  const res = await lessonByDocumentId(documentId);
  return res.data?.[0] ?? null;
}

/**
 * Every progress row for the given lessons, across ALL users — only useful
 * for admin_role (the lesson-progress-visibility policy scopes everyone
 * else to their own rows). The /manage/training report walks it PER COURSE
 * (`targetDocumentId $in <lesson ids>`), so the walk cap scales with the
 * course size, not with the global row count. Sorted by id: without an
 * ORDER BY, Postgres may return rows in a different order per page, and
 * the page walk would skip or repeat rows (WD02).
 */
export function fetchCourseProgress(
  lessonIds: string[],
  label: string,
): Promise<WalkResult<ProgressReportRow>> {
  return walkAllPages<ProgressReportRow>((page) => courseProgressPage(lessonIds, page), {
    maxPages: 20,
    label,
  });
}

/**
 * The caller's own completion receipts (the lesson-progress-visibility
 * policy scopes the list server-side). Returns a documentId →
 * completedAt map — the Map dedupes accidental duplicate rows (accepted
 * check-then-insert race, the oldest row wins: the walk is sorted by id,
 * which also keeps the pages stable on Postgres) and every consumer
 * derives its Set from the keys.
 */
export async function fetchMyProgress(): Promise<{
  completed: Map<string, string | null>;
  truncated: boolean;
}> {
  const result: WalkResult<MyProgressRow> = await walkAllPages<MyProgressRow>(myProgressPage, {
    maxPages: 20,
    label: "lesson-progress",
  });
  const completed = new Map<string, string | null>();
  for (const row of result.data) {
    if (typeof row.targetDocumentId === "string" && !completed.has(row.targetDocumentId)) {
      completed.set(row.targetDocumentId, row.completedAt ?? null);
    }
  }
  return { completed, truncated: result.truncated };
}
