import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { KpiEditor } from "@/components/manage/kpi-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadEditable } from "@/lib/loaders/manage/editor";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

type Params = { params: Promise<{ documentId: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.kpis");
  return { title: t("editTitle") };
}

/** One KPI's editor (v0.19), from `editable`. */
export default async function EditKpiPage({ params }: Params) {
  const { documentId } = await params;
  const { viewer, access } = await areaGate("kpis", "edit");
  const t = await getTranslations("manage.kpis");
  const header = (
    <ManagePageHeader title={t("editTitle")} back={AREA_PATH.kpis} backLabel={t("title")} />
  );
  if (lacksDepartment(access, viewer.department)) {
    return (
      <div className="space-y-8">
        {header}
        <NoDepartmentExplanation />
      </div>
    );
  }
  const departmentAuthor = access.roleClass === "departmentAuthor";
  const [load, options] = await Promise.all([
    loadEditable("kpis", documentId),
    loadTargetingOptions({ departments: !departmentAuthor, teams: false }),
  ]);
  if (load.state === "notFound") notFound();
  if (load.state === "failed") {
    return (
      <div className="space-y-8">
        {header}
        <FetchErrorBanner />
      </div>
    );
  }
  const { editable } = load;
  return (
    <div className="space-y-8">
      {header}
      <KpiEditor
        key={editable.documentId}
        editable={editable}
        access={access}
        timeZone={appTimeZone()}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={departmentAuthor ? viewer.department : null}
      />
    </div>
  );
}
