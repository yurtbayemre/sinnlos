import type { CourseEditable, LessonEditable } from "@sinnlos/domain";
import { fetchAuthoringList, fetchEditable } from "@/lib/api/manage/authoring";
import { isDocumentId } from "@/lib/entry-id";
import { tryFetch } from "@/lib/safe-fetch";
import { editableLoad, type EditorLoad } from "./editor";
import { NO_PAGES, type ListFilters, type ManageListView } from "./list";

export function loadCourseEditable(id: string): Promise<EditorLoad<CourseEditable>> {
  return editableLoad("manage-courses", id, () => fetchEditable<CourseEditable>("course", id));
}
export async function loadLessonEditable(
  course: string,
  id: string,
): Promise<EditorLoad<LessonEditable>> {
  if (!isDocumentId(course)) return { state: "notFound" };
  const result = await editableLoad("manage-lessons", id, () =>
    fetchEditable<LessonEditable>("lesson", id),
  );
  return result.state === "ok" && result.editable.course?.documentId !== course
    ? { state: "notFound" }
    : result;
}
/** The CMS filters the selected course before counting and paging. */
export async function loadLessonList(
  course: string,
  filters: ListFilters,
): Promise<ManageListView> {
  if (!isDocumentId(course)) return { rows: [], pagination: NO_PAGES, empty: true, failed: false };
  const result = await tryFetch(
    () =>
      fetchAuthoringList("lesson", {
        course,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.page > 1 ? { page: filters.page } : {}),
      }),
    "manage-lessons",
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  return {
    rows,
    pagination: result.data?.meta?.pagination ?? { ...NO_PAGES, page: filters.page },
    empty: !result.failed && rows.length === 0,
    failed: result.failed,
  };
}
