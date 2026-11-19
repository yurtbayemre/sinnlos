import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { ProcessEditor } from "@/components/manage/process-editor";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadEditable } from "@/lib/loaders/manage/editor";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

type Params = { params: Promise<{ documentId: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.processes");
  return { title: t("editTitle") };
}

/** One process's editor (v1.1), from `editable`. */
export default async function EditProcessPage({ params }: Params) {
  const { documentId } = await params;
  const { viewer, access } = await areaGate("processes", "edit");
  const t = await getTranslations("manage.processes");
  const header = (
    <ManagePageHeader title={t("editTitle")} back={AREA_PATH.processes} backLabel={t("title")} />
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
    loadEditable("processes", documentId),
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
      <ProcessEditor
        key={editable.documentId}
        editable={editable}
        access={access}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={departmentAuthor ? viewer.department : null}
      />
    </div>
  );
}
