import { FileText } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { canDo, lacksDepartment } from "@/lib/manage/access";
import { AREA_NEW_PATH, hasOwnerDepartment, type ManageArea } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import {
  loadManageList,
  parseListFilters,
  statusTabs,
  type ListSearchParams,
} from "@/lib/loaders/manage/list";
import { AuthoringList, ListPagination, ListToolbar } from "./list";
import { ManagePageHeader, NoDepartmentExplanation } from "./page-parts";

/**
 * One /manage/<area> list page (deep-dive decision 06 §L1; WD03): the gate,
 * then one loader call, then rendering. Moderators see every item, with
 * the owner department as a badge and filter on announcements and events;
 * a department author sees their department's items only (the cms's
 * authoringList decides), and without a department the explanation
 * instead of a list (§N1). A failed read shows the banner, never an empty
 * list.
 */
export async function ManageListPage({
  area,
  searchParams,
}: {
  area: ManageArea;
  searchParams: Promise<ListSearchParams>;
}) {
  const { viewer, access } = await areaGate(area);
  const t = await getTranslations(`manage.${area}`);
  const tc = await getTranslations("manage.common");
  const header = (
    <ManagePageHeader
      title={t("title")}
      description={
        access.roleClass === "departmentAuthor" && viewer.department
          ? `${t("description")} ${tc("departmentAuthor.ownItems")}`
          : t("description")
      }
      action={canDo(access, "create") ? { href: AREA_NEW_PATH[area], label: t("new") } : undefined}
    />
  );
  if (lacksDepartment(access, viewer.department)) {
    return (
      <div className="space-y-8">
        {header}
        <NoDepartmentExplanation />
      </div>
    );
  }

  const moderatorOwnerFilter = access.roleClass === "moderator" && hasOwnerDepartment(area);
  const filters = parseListFilters(area, await searchParams, {
    ownerFilter: moderatorOwnerFilter,
  });
  const view = await loadManageList(area, filters);
  const filtered = filters.status !== null || filters.q !== "" || filters.owner !== null;

  return (
    <div className="space-y-6">
      {header}
      {view.failed && <FetchErrorBanner />}
      <ListToolbar
        area={area}
        filters={filters}
        tabs={statusTabs(area)}
        ownerFilter={moderatorOwnerFilter}
      />
      {view.empty ? (
        filtered ? (
          <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {tc("list.emptyFiltered")}
          </p>
        ) : (
          <EmptyState icon={FileText} title={t("emptyTitle")} hint={t("emptyHint")} />
        )
      ) : view.rows.length > 0 ? (
        <AuthoringList area={area} rows={view.rows} showOwner={moderatorOwnerFilter} />
      ) : null}
      {!view.failed && !view.empty && (
        <ListPagination area={area} filters={filters} pagination={view.pagination} />
      )}
    </div>
  );
}
