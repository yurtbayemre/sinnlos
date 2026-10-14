import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { WikiSpaceEditor } from "@/components/manage/wiki-space-editor";
import { areaItemPath } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";
import { loadWikiSpaceEditable } from "@/lib/loaders/manage/wiki";

type Params = { params: Promise<{ space: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki");
  return { title: t("editTitle") };
}

/** One wiki space's form (deep-dive decision 06 §J1; moderators only), from `editable`. */
export default async function EditWikiSpacePage({ params }: Params) {
  const { space: documentId } = await params;
  const { access } = await areaGate("wiki", "edit");
  const t = await getTranslations("manage.wiki");
  const [load, options] = await Promise.all([
    loadWikiSpaceEditable(documentId),
    loadTargetingOptions({ departments: true, teams: true }),
  ]);
  if (load.state === "notFound") notFound();
  const header = (
    <ManagePageHeader
      title={t("editTitle")}
      back={areaItemPath("wiki", documentId)}
      backLabel={load.state === "ok" ? load.editable.name : t("title")}
    />
  );
  if (load.state === "failed") {
    return (
      <div className="space-y-8">
        {header}
        <FetchErrorBanner />
      </div>
    );
  }
  return (
    <div className="space-y-8">
      {header}
      <WikiSpaceEditor
        key={load.editable.documentId}
        editable={load.editable}
        access={access}
        departments={options.departments}
        teams={options.teams}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
    </div>
  );
}
