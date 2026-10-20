import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.dutyPlans");
  return { title: t("title") };
}

/** The duty plans of /manage (components/manage/list-page.tsx; v0.18). */
export default function ManageDutyPlansPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="dutyPlans" searchParams={searchParams} />;
}
