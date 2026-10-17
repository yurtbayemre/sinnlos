import { getTranslations } from "next-intl/server";
import { TrainingCourseEditor } from "@/components/manage/training-course-editor";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { areaGate } from "@/lib/manage/page-gate";
import { appTimeZone } from "@/lib/app-time-zone";

export async function generateMetadata() {
  const t = await getTranslations("manage.training");
  return { title: t("course.new") };
}
export default async function NewCoursePage() {
  const { access } = await areaGate("courses", "create");
  const t = await getTranslations("manage.training");
  return (
    <div className="space-y-8">
      <ManagePageHeader title={t("course.new")} back="/manage/training" backLabel={t("title")} />
      <TrainingCourseEditor editable={null} access={access} timeZone={appTimeZone()} />
    </div>
  );
}
