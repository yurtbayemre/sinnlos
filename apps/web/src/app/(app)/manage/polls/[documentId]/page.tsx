import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { PollEditor } from "@/components/manage/poll-editor";
import { PollPreview, PreviewSection } from "@/components/manage/previews";
import { appTimeZone } from "@/lib/app-time-zone";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadEditable } from "@/lib/loaders/manage/editor";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";
import { zonedDateKey } from "@/lib/plain-date";
import { isPollClosed } from "@/lib/poll-close";

type Params = { params: Promise<{ documentId: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.polls");
  return { title: t("editTitle") };
}

/**
 * One poll's editor (deep-dive decision 06 §A, §L4): editable after
 * creation; its answers and anonymity freeze at the first vote, and Close
 * now ends it (the poll close rule: closed iff now >= closesAt).
 */
export default async function EditPollPage({ params }: Params) {
  const { documentId } = await params;
  const { access } = await areaGate("polls", "edit");
  const t = await getTranslations("manage.polls");
  const header = (
    <ManagePageHeader title={t("editTitle")} back={AREA_PATH.polls} backLabel={t("title")} />
  );
  const [load, options] = await Promise.all([
    loadEditable("polls", documentId),
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
  const timeZone = appTimeZone();
  const now = new Date();
  const closed = isPollClosed(editable.closesAt, now);
  return (
    <div className="space-y-8">
      {header}
      <PollEditor
        key={editable.documentId}
        editable={editable}
        access={access}
        timeZone={timeZone}
        today={zonedDateKey(now, timeZone)}
        closed={closed}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
      <PreviewSection>
        <PollPreview editable={editable} closed={closed} />
      </PreviewSection>
    </div>
  );
}
