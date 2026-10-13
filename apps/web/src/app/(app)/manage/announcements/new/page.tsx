import { getTranslations } from "next-intl/server";
import { AnnouncementEditor } from "@/components/manage/announcement-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.announcements");
  return { title: t("new") };
}

/**
 * A new announcement (deep-dive decision 06 §L4): moderators and, for their
 * own department, department authors (§N). The department author's team
 * picker lists their department's teams only; they get no department list.
 */
export default async function NewAnnouncementPage() {
  const { viewer, access } = await areaGate("announcements", "create");
  const t = await getTranslations("manage.announcements");
  const header = (
    <ManagePageHeader
      title={t("new")}
      description={t("newDescription")}
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
  const options = await loadTargetingOptions({
    departments: !departmentAuthor,
    teams: true,
    teamsOf: departmentAuthor ? (viewer.department?.documentId ?? null) : null,
  });
  return (
    <div className="space-y-8">
      {header}
      <AnnouncementEditor
        editable={null}
        access={access}
        timeZone={appTimeZone()}
        departments={options.departments}
        teams={options.teams}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={departmentAuthor ? viewer.department : null}
      />
    </div>
  );
}
