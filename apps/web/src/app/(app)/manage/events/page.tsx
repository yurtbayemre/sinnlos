import { getTranslations } from "next-intl/server";
import { ManageListPage } from "@/components/manage/list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.events");
  return { title: t("title") };
}

/** The events of /manage (components/manage/list-page.tsx). */
export default function ManageEventsPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <ManageListPage area="events" searchParams={searchParams} />;
}
