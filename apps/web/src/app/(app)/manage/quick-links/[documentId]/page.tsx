import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { PreviewSection, QuickLinkPreview } from "@/components/manage/previews";
import { QuickLinkEditor } from "@/components/manage/quick-link-editor";
import { appTimeZone } from "@/lib/app-time-zone";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadEditable } from "@/lib/loaders/manage/editor";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";

type Params = { params: Promise<{ documentId: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.quickLinks");
  return { title: t("editTitle") };
}

/** One quick link's editor and preview (deep-dive decision 06 §L4), from `editable`. */
export default async function EditQuickLinkPage({ params }: Params) {
  const { documentId } = await params;
  const { access } = await areaGate("quickLinks", "edit");
  const t = await getTranslations("manage.quickLinks");
  const header = (
    <ManagePageHeader title={t("editTitle")} back={AREA_PATH.quickLinks} backLabel={t("title")} />
  );
  const [load, options] = await Promise.all([
    loadEditable("quickLinks", documentId),
    loadTargetingOptions({ departments: true, teams: false }),
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
      <QuickLinkEditor
        key={editable.documentId}
        editable={editable}
        access={access}
        timeZone={appTimeZone()}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
      <PreviewSection>
        <QuickLinkPreview editable={editable} />
      </PreviewSection>
    </div>
  );
}
