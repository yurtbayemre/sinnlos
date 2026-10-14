import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { DocumentEditor } from "@/components/manage/document-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { DocumentPreview, PreviewSection } from "@/components/manage/previews";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadEditable } from "@/lib/loaders/manage/editor";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

type Params = { params: Promise<{ documentId: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.documents");
  return { title: t("editTitle") };
}

/**
 * One document's editor and preview (deep-dive decision 06 §L4, §L6), both
 * from `editable`: a department author reaches only their department's
 * documents (the cms answers 404 otherwise, and so does this page). The
 * form offers the fields of the class the cms names (`roleClass`).
 */
export default async function EditDocumentPage({ params }: Params) {
  const { documentId } = await params;
  const { viewer, access } = await areaGate("documents", "edit");
  const t = await getTranslations("manage.documents");
  const header = (
    <ManagePageHeader title={t("editTitle")} back={AREA_PATH.documents} backLabel={t("title")} />
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
    loadEditable("documents", documentId),
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
      <DocumentEditor
        key={editable.documentId}
        editable={editable}
        access={{ ...access, roleClass: editable.roleClass }}
        timeZone={appTimeZone()}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={editable.roleClass === "departmentAuthor" ? viewer.department : null}
      />
      <PreviewSection>
        <DocumentPreview editable={editable} />
      </PreviewSection>
    </div>
  );
}
