import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.announcements");
  return { title: t("title") };
}

/** The announcements of /manage (components/manage/list-page.tsx). */
export default function ManageAnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="announcements" searchParams={searchParams} />;
}
