import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.quickLinks");
  return { title: t("title") };
}

/** The quickLinks of /manage (components/manage/list-page.tsx). */
export default function ManageQuickLinksPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="quickLinks" searchParams={searchParams} />;
}
