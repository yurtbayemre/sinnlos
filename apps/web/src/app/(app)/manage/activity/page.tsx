import { redirect } from "next/navigation";
import { Activity } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { AdminPageHeader } from "@/components/admin-page-header";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import {
  ActivityFiltersForm,
  ActivityList,
  ActivityPagination,
} from "@/components/manage/activity";
import { appTimeZone } from "@/lib/app-time-zone";
import { loadActivity, parseActivityFilters } from "@/lib/loaders/manage/activity";
import type { ListSearchParams } from "@/lib/loaders/manage/list";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata() {
  const t = await getTranslations("manage.activity");
  return { title: t("title") };
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  if (!capabilitiesFor((await getViewer()).role).reports.activity) redirect("/");
  const timeZone = appTimeZone();
  const filters = parseActivityFilters(await searchParams);
  const [t, view] = await Promise.all([
    getTranslations("manage.activity"),
    loadActivity(filters, timeZone),
  ]);
  return (
    <div className="space-y-8">
      <AdminPageHeader title={t("title")} description={t("description")} />
      <ActivityFiltersForm
        key={JSON.stringify(filters)}
        filters={filters}
        timeZone={timeZone}
        invalid={view.invalid}
      />
      {view.invalid && (
        <p id="activity-filter-error" role="alert" className="text-sm text-destructive">
          {t("invalidFilters")}
        </p>
      )}
      {view.failed && <FetchErrorBanner />}
      {view.empty && <EmptyState icon={Activity} title={t("emptyTitle")} hint={t("emptyHint")} />}
      {view.rows.length > 0 && <ActivityList rows={view.rows} />}
      {!view.invalid && !view.failed && (
        <ActivityPagination filters={filters} pagination={view.pagination} />
      )}
    </div>
  );
}
