import { getTranslations } from "next-intl/server";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { ProcessEditor } from "@/components/manage/process-editor";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.processes");
  return { title: t("new") };
}

/**
 * A new process (v1.1): moderators for any department or the whole company;
 * department heads and team leads for their own department, which is pinned
 * and shown.
 */
export default async function NewProcessPage() {
  const { viewer, access } = await areaGate("processes", "create");
  const t = await getTranslations("manage.processes");
  const header = (
    <ManagePageHeader
      title={t("new")}
      description={t("newDescription")}
      back={AREA_PATH.processes}
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
      <ProcessEditor
        editable={null}
        access={access}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={departmentAuthor ? viewer.department : null}
      />
    </div>
  );
}
