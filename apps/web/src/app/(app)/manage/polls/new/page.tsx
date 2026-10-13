import { getTranslations } from "next-intl/server";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { PollEditor } from "@/components/manage/poll-editor";
import { appTimeZone } from "@/lib/app-time-zone";
import { AREA_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";
import { zonedDateKey } from "@/lib/plain-date";

export async function generateMetadata() {
  const t = await getTranslations("manage.polls");
  return { title: t("new") };
}

/**
 * A new poll (deep-dive decision 06 §A, §L4; moderators only): published
 * when it is created. /polls/new redirects here. The earliest closing day
 * is today in APP_TIME_ZONE (the browser cannot know the zone).
 */
export default async function NewPollPage() {
  const { access } = await areaGate("polls", "create");
  const t = await getTranslations("manage.polls");
  const timeZone = appTimeZone();
  const options = await loadTargetingOptions({ departments: true, teams: false });
  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("new")}
        description={t("newDescription")}
        back={AREA_PATH.polls}
        backLabel={t("title")}
      />
      <PollEditor
        editable={null}
        access={access}
        timeZone={timeZone}
        today={zonedDateKey(new Date(), timeZone)}
        closed={false}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
    </div>
  );
}
