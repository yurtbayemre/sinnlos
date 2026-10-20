import { getTranslations } from "next-intl/server";
import { DutyPlanEditor } from "@/components/manage/duty-plan-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadDutyPeople } from "@/lib/loaders/manage/duty-people";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.dutyPlans");
  return { title: t("new") };
}

/**
 * A new duty plan (v0.18): moderators for any department or the whole
 * company; department heads and team leads for their own department,
 * which is pinned and shown.
 */
export default async function NewDutyPlanPage() {
  const { viewer, access } = await areaGate("dutyPlans", "create");
  const t = await getTranslations("manage.dutyPlans");
  const header = (
    <ManagePageHeader
      title={t("new")}
      description={t("newDescription")}
      back={AREA_PATH.dutyPlans}
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
  const [options, people] = await Promise.all([
    loadTargetingOptions({ departments: !departmentAuthor, teams: false }),
    loadDutyPeople(),
  ]);
  return (
    <div className="space-y-8">
      {header}
      <DutyPlanEditor
        editable={null}
        access={access}
        timeZone={appTimeZone()}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={departmentAuthor ? viewer.department : null}
        people={people.people}
        peopleFailed={people.failed}
      />
    </div>
  );
}
