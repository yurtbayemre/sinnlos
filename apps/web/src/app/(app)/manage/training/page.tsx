import { getTranslations } from "next-intl/server";
import { TrainingListPage } from "@/components/manage/training-list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.training");
  return { title: t("title") };
}
export default function TrainingPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  return <TrainingListPage searchParams={searchParams} />;
}
