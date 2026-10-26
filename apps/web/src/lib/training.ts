import { newestReceipts } from "@sinnlos/domain";

import {
  courseBySlug,
  coursesPage,
  lessonByDocumentId,
  myProgressPage,
  type CourseView,
  type LessonView,
  type MyProgressRow,
} from "@/lib/api/training";
import { StrapiError } from "@/lib/strapi-error";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { getViewer } from "@/lib/viewer";

/**
 * Training data helpers (issue #29): the page walks, their caps and the
 * result shaping; each request is one function of lib/api/training.ts
 * (WD01). Every response is per-user: courses and lessons are status- and
 * audience-gated per role (admin/editor see drafts) and progress is
 * strictly the caller's own; the named report is the cms's
 * /api/courses/report (v0.20). Uncached like every strapi() read (D-DC01).
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
 * The caller's own completion receipts (the lesson-progress-visibility
 * policy scopes the list server-side). Returns a documentId →
 * completedAt map of the NEWEST receipt per lesson: a renewed lesson
 * (v0.20) has several receipts, and accidental duplicates (accepted
 * check-then-insert race) collapse too. The walk is sorted by id, which
 * keeps the pages stable on Postgres. With `lessonDocumentId`, only that
 * lesson's receipts (#181: the lesson page; the whole walk stops at 2,000
 * receipts, and a lesson completed past them showed as open).
 */
export async function fetchMyProgress(lessonDocumentId?: string): Promise<{
  completed: Map<string, string | null>;
  truncated: boolean;
}> {
  const { id } = await getViewer();
  // Without an identity nothing is known: fail closed (the callers' tryFetch).
  if (id === null) throw new Error("lesson-progress: no viewer id");
  const result: WalkResult<MyProgressRow> = await walkAllPages<MyProgressRow>(
    (page) => myProgressPage(id, page, lessonDocumentId),
    { maxPages: 20, label: "lesson-progress" },
  );
  return { completed: newestReceipts(result.data), truncated: result.truncated };
}
