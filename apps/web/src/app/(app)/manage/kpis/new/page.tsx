import { getTranslations } from "next-intl/server";
import { KpiEditor } from "@/components/manage/kpi-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.kpis");
  return { title: t("new") };
}

/**
 * A new KPI (v0.19): moderators for any department or the whole company;
 * department heads for their own department, which is pinned and shown.
 */
export default async function NewKpiPage() {
  const { viewer, access } = await areaGate("kpis", "create");
  const t = await getTranslations("manage.kpis");
  const header = (
    <ManagePageHeader
      title={t("new")}
      description={t("newDescription")}
      back={AREA_PATH.kpis}
      backLabel={t("title")}
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
  const departmentAuthor = access.roleClass === "departmentAuthor";
  const options = await loadTargetingOptions({ departments: !departmentAuthor, teams: false });
  return (
    <div className="space-y-8">
      {header}
      <KpiEditor
        editable={null}
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
