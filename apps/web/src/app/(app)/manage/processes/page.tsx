import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.processes");
  return { title: t("title") };
}

/** The processes of /manage (components/manage/list-page.tsx; v1.1). */
export default function ManageProcessesPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="processes" searchParams={searchParams} />;
}
