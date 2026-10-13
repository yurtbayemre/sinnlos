import { getTranslations } from "next-intl/server";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { QuickLinkEditor } from "@/components/manage/quick-link-editor";
import { appTimeZone } from "@/lib/app-time-zone";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.quickLinks");
  return { title: t("new") };
}

/** A new quick link (deep-dive decision 06 §L4; moderators only). */
export default async function NewQuickLinkPage() {
  const { access } = await areaGate("quickLinks", "create");
  const t = await getTranslations("manage.quickLinks");
  const options = await loadTargetingOptions({ departments: true, teams: false });
  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("new")}
        description={t("newDescription")}
        back={AREA_PATH.quickLinks}
        backLabel={t("title")}
      />
      <QuickLinkEditor
        editable={null}
        access={access}
        timeZone={appTimeZone()}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
    </div>
  );
}
