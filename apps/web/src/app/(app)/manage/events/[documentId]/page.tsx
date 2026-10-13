import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { EventEditor } from "@/components/manage/event-editor";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { EventPreview, PreviewSection } from "@/components/manage/previews";
import { appTimeZone } from "@/lib/app-time-zone";
import { lacksDepartment } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadEditable, loadEventYesCount } from "@/lib/loaders/manage/editor";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

type Params = { params: Promise<{ documentId: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.events");
  return { title: t("editTitle") };
}

/**
 * One event's editor and preview (deep-dive decision 06 §L4), from
 * `editable`, with the number of people who accepted for the capacity
 * warning (published events only; unknown otherwise).
 */
export default async function EditEventPage({ params }: Params) {
  const { documentId } = await params;
  const { viewer, access } = await areaGate("events", "edit");
  const t = await getTranslations("manage.events");
  const header = (
    <ManagePageHeader title={t("editTitle")} back={AREA_PATH.events} backLabel={t("title")} />
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
    loadEditable("events", documentId),
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
  const yesCount = editable.publishedAt ? await loadEventYesCount(editable.documentId) : null;
  const timeZone = appTimeZone();
  return (
    <div className="space-y-8">
      {header}
      <EventEditor
        key={editable.documentId}
        editable={editable}
        access={{ ...access, roleClass: editable.roleClass }}
        timeZone={timeZone}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
        ownDepartment={editable.roleClass === "departmentAuthor" ? viewer.department : null}
        yesCount={yesCount}
      />
      <PreviewSection>
        <EventPreview editable={editable} timeZone={timeZone} />
      </PreviewSection>
    </div>
  );
}
