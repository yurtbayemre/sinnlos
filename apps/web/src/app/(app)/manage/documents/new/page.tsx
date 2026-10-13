import { getTranslations } from "next-intl/server";
import { DocumentEditor } from "@/components/manage/document-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.documents");
  return { title: t("new") };
}

/**
 * A new document (deep-dive decision 06 §L4, §L6): moderators and, for
 * their own department, department authors (amendment 1). A department
 * author gets no department list: their department is pinned and shown.
 */
export default async function NewDocumentPage() {
  const { viewer, access } = await areaGate("documents", "create");
  const t = await getTranslations("manage.documents");
  const header = (
    <ManagePageHeader
      title={t("new")}
      description={t("newDescription")}
      back={AREA_PATH.documents}
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
      <DocumentEditor
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
