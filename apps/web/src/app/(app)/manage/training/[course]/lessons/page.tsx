import { getTranslations } from "next-intl/server";
import { TrainingListPage } from "@/components/manage/training-list-page";
import type { ListSearchParams } from "@/lib/loaders/manage/list";

export async function generateMetadata() {
  const t = await getTranslations("manage.training");
  return { title: t("lesson.title") };
}
export default async function LessonsPage({
  params,
  searchParams,
}: {
  params: Promise<{ course: string }>;
  searchParams: Promise<ListSearchParams>;
}) {
  const { course } = await params;
  return <TrainingListPage courseId={course} searchParams={searchParams} />;
}
