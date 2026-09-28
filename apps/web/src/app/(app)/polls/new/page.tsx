import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { appTimeZone } from "@/lib/app-time-zone";
import { zonedDateKey } from "@/lib/plain-date";
import { canCreatePolls } from "@/lib/roles";
import { api } from "@/lib/strapi";
import { getViewer } from "@/lib/viewer";
import { tryFetch } from "@/lib/safe-fetch";
import { PageHeader } from "@/components/page-header";
import { PollForm } from "@/components/polls/poll-form";

export async function generateMetadata() {
  const t = await getTranslations("polls");
  return { title: t("newPoll") };
}

export default async function NewPollPage() {
  if (!canCreatePolls((await getViewer()).role)) redirect("/polls");

  const t = await getTranslations("polls");
  // A failed department fetch must not look like "no departments": the form
  // could then only create a company-wide poll (decision 02), so it refuses
  // to submit instead.
  const { data, failed } = await tryFetch(() => api.departments.list(), "departments");
  const departments = ((data?.data ?? []) as { id: number; name: string }[]).map((d) => ({
    id: d.id,
    name: d.name,
  }));

  return (
    <div className="space-y-8">
      <PageHeader title={t("newPoll")} description={t("newPollDescription")} />
      {/* The earliest closing day is today in APP_TIME_ZONE (the form cannot
          know the zone; poll-actions.ts turns day D into D 23:59:59 there). */}
      <PollForm
        departments={departments}
        departmentsUnavailable={failed}
        minDate={zonedDateKey(new Date(), appTimeZone())}
      />
    </div>
  );
}
