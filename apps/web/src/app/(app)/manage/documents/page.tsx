import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.documents");
  return { title: t("title") };
}

/**
 * The documents of /manage (components/manage/list-page.tsx; batch 16 plan,
 * lane 16C items 1 and 3): moderators every document, with the owner
 * filter; a department author their department's documents only.
 */
export default function ManageDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="documents" searchParams={searchParams} />;
}
