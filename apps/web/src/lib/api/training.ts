/**
 * Training reads (issue #29, WD01): one function per Strapi request; the
 * page walks and their caps live in lib/training.ts. Every response is
 * per-user: courses and lessons are status-gated per role (admin/editor see
 * drafts) and progress is strictly the caller's own (admin_role: all rows).
 * Uncached (D-DC01).
 */
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery, type StrapiQuery } from "@/lib/strapi/query";
import type { Course, Lesson, LessonProgress } from "@/lib/types";

/** A course as the lists and the course page read it: lesson outline and cover. */
export type CourseView = Omit<Course, "lessons"> & {
  lessons?: Pick<Lesson, "id" | "documentId" | "title" | "order">[];
};

/** A lesson with its course's title, slug and documentId. */
export type LessonView = Omit<Lesson, "course"> & {
  course?: Pick<Course, "id" | "documentId" | "title" | "slug"> | null;
};

/** A progress row as the report reads it: the lesson and the user's id. */
export type ProgressReportRow = Pick<LessonProgress, "id" | "targetDocumentId"> & {
  user?: { id: number } | null;
};

/** A progress row as the caller's own list reads it: the lesson and when. */
export type MyProgressRow = Pick<LessonProgress, "id" | "targetDocumentId" | "completedAt">;

/** The lesson outline (documentId, title, order) and the cover image. */
const withOutline = (query: StrapiQuery) =>
  query.populateFields("lessons", ["documentId", "title", "order"]).populate("coverImage");

/** One page of the courses, by title (id as the tie-breaker for a stable walk). */
export function coursesPage(page: number): Promise<StrapiListResponse<CourseView>> {
  return strapi<StrapiListResponse<CourseView>>(
    withQuery(
      "/api/courses",
      withOutline(strapiQuery()).sort(["title:asc", "id:asc"]).page(page, 100),
    ),
  );
}

/** The course with this slug (a uid: 0..1 rows). */
export function courseBySlug(slug: string): Promise<StrapiListResponse<CourseView>> {
  return strapi<StrapiListResponse<CourseView>>(
    withQuery("/api/courses", withOutline(strapiQuery().filter("slug", "$eq", slug))),
  );
}

/** The lesson with this documentId, with its course's title, slug and documentId. */
export function lessonByDocumentId(documentId: string): Promise<StrapiListResponse<LessonView>> {
  return strapi<StrapiListResponse<LessonView>>(
    withQuery(
      "/api/lessons",
      strapiQuery()
        .filter("documentId", "$eq", documentId)
        .populateFields("course", ["title", "slug", "documentId"]),
    ),
  );
}

/**
 * One page of the progress rows of the given lessons across all users
 * (admin_role, the /manage/training report), sorted by id: without an
 * ORDER BY, Postgres may return rows in a different order per page, and the
 * page walk would skip or repeat rows (WD02).
 */
export function courseProgressPage(
  lessonIds: readonly string[],
  page: number,
): Promise<StrapiListResponse<ProgressReportRow>> {
  return strapi<StrapiListResponse<ProgressReportRow>>(
    withQuery(
      "/api/lesson-progresses",
      strapiQuery()
        .filterIn("targetDocumentId", lessonIds)
        .fields(["targetDocumentId"])
        .populateFields("user", ["id"])
        .sort(["id:asc"])
        .page(page, 100),
    ),
  );
}

/** One page of the caller's own completion receipts, sorted by id. */
export function myProgressPage(page: number): Promise<StrapiListResponse<MyProgressRow>> {
  return strapi<StrapiListResponse<MyProgressRow>>(
    withQuery(
      "/api/lesson-progresses",
      strapiQuery().fields(["targetDocumentId", "completedAt"]).sort(["id:asc"]).page(page, 100),
    ),
  );
}
