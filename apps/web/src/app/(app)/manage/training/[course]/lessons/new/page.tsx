import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { TrainingLessonEditor } from "@/components/manage/training-lesson-editor";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { areaGate } from "@/lib/manage/page-gate";
import { lessonListPath } from "@/lib/manage/training-paths";
import { loadCourseEditable } from "@/lib/loaders/manage/training";
import { appTimeZone } from "@/lib/app-time-zone";

export async function generateMetadata() {
  const t = await getTranslations("manage.training");
  return { title: t("lesson.new") };
}
export default async function NewLessonPage({ params }: { params: Promise<{ course: string }> }) {
  const { access } = await areaGate("lessons", "create");
  const { course } = await params;
  const t = await getTranslations("manage.training");
  const load = await loadCourseEditable(course);
  if (load.state === "notFound") notFound();
  const header = (
    <ManagePageHeader
      title={t("lesson.new")}
      back={lessonListPath(course)}
      backLabel={t("lesson.title")}
    />
  );
  if (load.state === "failed")
    return (
      <div className="space-y-8">
        {header}
        <FetchErrorBanner />
      </div>
    );
  return (
    <div className="space-y-8">
      {header}
      <TrainingLessonEditor
        editable={null}
        course={load.editable}
        access={access}
        timeZone={appTimeZone()}
      />
    </div>
  );
}
