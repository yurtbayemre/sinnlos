import { newestReceipts } from "@sinnlos/domain";

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
import { StrapiError } from "@/lib/strapi-error";
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
  try {
    return (await lessonByDocumentId(documentId)).data;
  } catch (error) {
    if (error instanceof StrapiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Every progress row for the given lessons, across ALL users — only useful
 * for admin_role (the lesson-progress-visibility policy scopes everyone
 * else to their own rows). The /manage/training/report report walks it PER COURSE
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
 * completedAt map of the NEWEST receipt per lesson: a renewed lesson
 * (v0.20) has several receipts, and accidental duplicates (accepted
 * check-then-insert race) collapse too. The walk is sorted by id, which
 * keeps the pages stable on Postgres.
 */
export async function fetchMyProgress(): Promise<{
  completed: Map<string, string | null>;
  truncated: boolean;
}> {
  const result: WalkResult<MyProgressRow> = await walkAllPages<MyProgressRow>(myProgressPage, {
    maxPages: 20,
    label: "lesson-progress",
  });
  return { completed: newestReceipts(result.data), truncated: result.truncated };
}
