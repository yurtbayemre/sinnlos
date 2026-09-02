import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import type { Course, Lesson, LessonProgress } from "@/lib/types";

/**
 * Training data helpers (issue #29). Everything runs noCache: courses
 * and lessons are status-gated per role (admin/editor see drafts) and
 * progress is strictly per-user — a URL-keyed cache entry would leak
 * across users (§ caching rule: user-variable ⇒ noCache).
 */

const COURSE_POPULATE =
  "populate[lessons][fields][0]=documentId&populate[lessons][fields][1]=title&populate[lessons][fields][2]=order&populate[coverImage]=true";

export async function fetchCourses(): Promise<{ courses: Course[]; truncated: boolean }> {
  const result: WalkResult<Course> = await walkAllPages<Course>(
    (page) =>
      strapi<StrapiListResponse<Course>>(
        `/api/courses?${COURSE_POPULATE}&sort[0]=title:asc&sort[1]=id:asc&pagination[page]=${page}&pagination[pageSize]=100`,
        { noCache: true },
      ),
    { maxPages: 20, label: "courses" },
  );
  return { courses: result.data, truncated: result.truncated };
}

export async function fetchCourseBySlug(slug: string): Promise<Course | null> {
  const res = await strapi<StrapiListResponse<Course>>(
    `/api/courses?filters[slug][$eq]=${encodeURIComponent(slug)}&${COURSE_POPULATE}`,
    { noCache: true },
  );
  return (res.data?.[0] as Course | undefined) ?? null;
}

export async function fetchLessonByDocumentId(documentId: string): Promise<Lesson | null> {
  const res = await strapi<StrapiListResponse<Lesson>>(
    `/api/lessons?filters[documentId][$eq]=${encodeURIComponent(documentId)}&populate[course][fields][0]=title&populate[course][fields][1]=slug&populate[course][fields][2]=documentId`,
    { noCache: true },
  );
  return (res.data?.[0] as Lesson | undefined) ?? null;
}

/**
 * The caller's own completion receipts (the lesson-progress-visibility
 * policy scopes the list server-side). Returns a documentId →
 * completedAt map — the Map dedupes accidental duplicate rows (accepted
 * check-then-insert race, first row wins) and every consumer derives
 * its Set from the keys.
 */
export async function fetchMyProgress(): Promise<{
  completed: Map<string, string | null>;
  truncated: boolean;
}> {
  const result: WalkResult<LessonProgress> = await walkAllPages<LessonProgress>(
    (page) =>
      strapi<StrapiListResponse<LessonProgress>>(
        `/api/lesson-progresses?fields[0]=targetDocumentId&fields[1]=completedAt&pagination[page]=${page}&pagination[pageSize]=100`,
        { noCache: true },
      ),
    { maxPages: 20, label: "lesson-progress" },
  );
  const completed = new Map<string, string | null>();
  for (const row of result.data) {
    if (typeof row.targetDocumentId === "string" && !completed.has(row.targetDocumentId)) {
      completed.set(row.targetDocumentId, row.completedAt ?? null);
    }
  }
  return { completed, truncated: result.truncated };
}
