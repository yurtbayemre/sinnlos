import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.kpis");
  return { title: t("title") };
}

/** The KPIs of /manage (components/manage/list-page.tsx; v0.19). */
export default function ManageKpisPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="kpis" searchParams={searchParams} />;
}
