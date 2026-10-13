import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.polls");
  return { title: t("title") };
}

/** The polls of /manage (components/manage/list-page.tsx). */
export default function ManagePollsPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="polls" searchParams={searchParams} />;
}
