import { getTranslations } from "next-intl/server";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { WikiSpaceEditor } from "@/components/manage/wiki-space-editor";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki");
  return { title: t("new") };
}

/** A new wiki space (deep-dive decision 06 §J1; moderators only). */
export default async function NewWikiSpacePage() {
  const { access } = await areaGate("wiki", "create");
  const t = await getTranslations("manage.wiki");
  const options = await loadTargetingOptions({ departments: true, teams: true });
  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("new")}
        description={t("newDescription")}
        back={AREA_PATH.wiki}
        backLabel={t("title")}
      />
      <WikiSpaceEditor
        editable={null}
        access={access}
        departments={options.departments}
        teams={options.teams}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
    </div>
  );
}
