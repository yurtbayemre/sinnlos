import { getTranslations } from "next-intl/server";
import { EventEditor } from "@/components/manage/event-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.events");
  return { title: t("new") };
}

/** A new event (deep-dive decision 06 §L4, §N4): moderators and department authors. */
export default async function NewEventPage() {
  const { viewer, access } = await areaGate("events", "create");
  const t = await getTranslations("manage.events");
  const header = (
    <ManagePageHeader
      title={t("new")}
      description={t("newDescription")}
      back={AREA_PATH.events}
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
  // A department author notifies their own department, pinned: no list.
  const options = await loadTargetingOptions({ departments: !departmentAuthor, teams: false });
  return (
    <div className="space-y-8">
      {header}
      <EventEditor
        editable={null}
        access={access}
        timeZone={appTimeZone()}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={departmentAuthor ? viewer.department : null}
        yesCount={null}
      />
    </div>
  );
}
