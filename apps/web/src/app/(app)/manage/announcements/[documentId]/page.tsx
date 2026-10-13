import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { AnnouncementEditor } from "@/components/manage/announcement-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { AnnouncementPreview, PreviewSection } from "@/components/manage/previews";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadEditable } from "@/lib/loaders/manage/editor";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

type Params = { params: Promise<{ documentId: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.announcements");
  return { title: t("editTitle") };
}

/**
 * One announcement's editor and preview (deep-dive decision 06 §L4), both
 * from `editable`: a department author reaches only their department's
 * items (the cms answers 404 otherwise, and so does this page). The form
 * offers the fields of the class the cms names (`roleClass`).
 */
export default async function EditAnnouncementPage({ params }: Params) {
  const { documentId } = await params;
  const { viewer, access } = await areaGate("announcements", "edit");
  const t = await getTranslations("manage.announcements");
  const header = (
    <ManagePageHeader
      title={t("editTitle")}
      back={AREA_PATH.announcements}
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
  const [load, options] = await Promise.all([
    loadEditable("announcements", documentId),
    loadTargetingOptions({
      departments: !departmentAuthor,
      teams: true,
      teamsOf: departmentAuthor ? (viewer.department?.documentId ?? null) : null,
    }),
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
      <AnnouncementEditor
        key={editable.documentId}
        editable={editable}
        access={{ ...access, roleClass: editable.roleClass }}
        timeZone={appTimeZone()}
        departments={options.departments}
        teams={options.teams}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={editable.roleClass === "departmentAuthor" ? viewer.department : null}
      />
      <PreviewSection>
        <AnnouncementPreview editable={editable} />
      </PreviewSection>
    </div>
  );
}
