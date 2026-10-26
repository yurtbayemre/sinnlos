/**
 * Training reads (issue #29, WD01): one function per Strapi request; the
 * page walks and their caps live in lib/training.ts. Every response is
 * per-user: courses and lessons are status-gated per role (admin/editor see
 * drafts), progress is strictly the caller's own (admin_role: all rows), and
 * the named report is scoped by the cms to the caller's role and department.
 * Uncached (D-DC01).
 */
import type {
  LessonPlayerResponse,
  TrainingReportCourseResponse,
  TrainingReportSummaryResponse,
} from "@sinnlos/domain";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery, type StrapiQuery } from "@/lib/strapi/query";
import type { Course, Lesson, LessonProgress } from "@/lib/types";

/** A course as the lists and the course page read it: lesson outline and cover. */
export type CourseView = Omit<Course, "lessons"> & {
  lessons?: Pick<Lesson, "id" | "documentId" | "title" | "order">[];
};

/** The fixed, answerless learner response, independent of authoring reads. */
export type LessonView = LessonPlayerResponse["data"];

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

/** The published player content; generic lesson reads never carry quiz data. */
export function lessonByDocumentId(documentId: string): Promise<LessonPlayerResponse> {
  return strapi<LessonPlayerResponse>(`/api/lessons/${encodeURIComponent(documentId)}/player`);
}

/** The named training report (v0.20): the mandatory courses in the caller's scope. */
export function trainingReport(): Promise<TrainingReportSummaryResponse> {
  return strapi<TrainingReportSummaryResponse>("/api/courses/report");
}

/** One course's people and receipts in the caller's scope; 404 outside it. */
/**
 * `leavers` (v0.28, admin_role only; the cms answers 403 to anyone else):
 * the blocked and anonymised people with receipts for the course, apart.
 */
export function courseTrainingReport(
  documentId: string,
  { leavers = false }: { leavers?: boolean } = {},
): Promise<TrainingReportCourseResponse> {
  return strapi<TrainingReportCourseResponse>(
    `/api/courses/${encodeURIComponent(documentId)}/report${leavers ? "?leavers=1" : ""}`,
  );
}

/** One page of the caller's own completion receipts (of one lesson, if given), sorted by id. */
export function myProgressPage(
  userId: number,
  page: number,
  lessonDocumentId?: string,
): Promise<StrapiListResponse<MyProgressRow>> {
  const query = strapiQuery()
    // lesson-progress-visibility lets admin_role read everyone's
    // receipts: they must not count as the admin's own.
    .filter(["user", "id"], "$eq", userId);
  if (lessonDocumentId !== undefined) query.filter("targetDocumentId", "$eq", lessonDocumentId);
  return strapi<StrapiListResponse<MyProgressRow>>(
    withQuery(
      "/api/lesson-progresses",
      query.fields(["targetDocumentId", "completedAt"]).sort(["id:asc"]).page(page, 100),
    ),
  );
}
