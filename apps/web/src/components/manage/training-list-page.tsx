import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BookOpen } from "lucide-react";
import { FetchErrorBanner } from "@/components/fetch-error";
import { EmptyState } from "@/components/empty-state";
import { areaGate } from "@/lib/manage/page-gate";
import { coursePath, lessonListPath, lessonPath, newLessonPath } from "@/lib/manage/training-paths";
import {
  loadManageList,
  parseListFilters,
  statusTabs,
  type ListSearchParams,
} from "@/lib/loaders/manage/list";
import { loadCourseEditable, loadLessonList } from "@/lib/loaders/manage/training";
import { ManagePageHeader } from "./page-parts";
import { AuthoringList, ListToolbar, ListPagination } from "./list";

export async function TrainingListPage({
  courseId,
  searchParams,
}: {
  courseId?: string;
  searchParams: Promise<ListSearchParams>;
}) {
  const area = courseId ? "lessons" : "courses";
  await areaGate(area);
  const t = await getTranslations("manage.training");
  const tc = await getTranslations("manage.common");
  const parent = courseId ? await loadCourseEditable(courseId) : null;
  if (parent?.state === "notFound") notFound();
  const basePath = courseId ? lessonListPath(courseId) : "/manage/training";
  const kind = courseId ? "lesson" : "course";
  const header = (
    <ManagePageHeader
      title={t(`${kind}.title`)}
      description={parent?.state === "ok" ? parent.editable.title : t("description")}
      back={courseId ? coursePath(courseId) : undefined}
      backLabel={courseId ? t("course.editTitle") : undefined}
      action={
        parent?.state === "failed"
          ? undefined
          : {
              href: courseId ? newLessonPath(courseId) : "/manage/training/new",
              label: t(`${kind}.new`),
            }
      }
    />
  );
  if (parent?.state === "failed")
    return (
      <div className="space-y-8">
        {header}
        <FetchErrorBanner />
      </div>
    );
  const filters = parseListFilters(area, await searchParams, { ownerFilter: false });
  const view = courseId
    ? await loadLessonList(courseId, filters)
    : await loadManageList("courses", filters);
  const filtered = filters.status !== null || filters.q !== "";
  return (
    <div className="space-y-6">
      {header}
      {view.failed && <FetchErrorBanner />}
      <ListToolbar
        area={area}
        basePath={basePath}
        filters={filters}
        tabs={statusTabs(area)}
        ownerFilter={false}
      />
      {view.empty ? (
        filtered ? (
          <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {tc("list.emptyFiltered")}
          </p>
        ) : (
          <EmptyState
            icon={BookOpen}
            title={t(`${kind}.emptyTitle`)}
            hint={t(`${kind}.emptyHint`)}
          />
        )
      ) : view.rows.length > 0 ? (
        <AuthoringList
          area={area}
          rows={view.rows}
          showOwner={false}
          itemPath={(id) => (courseId ? lessonPath(courseId, id) : coursePath(id))}
        />
      ) : null}
      {!view.failed && !view.empty && (
        <ListPagination
          area={area}
          basePath={basePath}
          filters={filters}
          pagination={view.pagination}
        />
      )}
    </div>
  );
}
