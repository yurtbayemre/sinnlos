import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { TrainingLessonEditor } from "@/components/manage/training-lesson-editor";
import { LessonPreview } from "@/components/manage/training-previews";
import { PreviewSection } from "@/components/manage/previews";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { areaGate } from "@/lib/manage/page-gate";
import { lessonListPath } from "@/lib/manage/training-paths";
import { loadLessonEditable } from "@/lib/loaders/manage/training";
import { appTimeZone } from "@/lib/app-time-zone";

export async function generateMetadata() {
  const t = await getTranslations("manage.training");
  return { title: t("lesson.editTitle") };
}
export default async function EditLessonPage({
  params,
}: {
  params: Promise<{ course: string; lesson: string }>;
}) {
  const { access } = await areaGate("lessons", "edit");
  const { course, lesson } = await params;
  const t = await getTranslations("manage.training");
  const load = await loadLessonEditable(course, lesson);
  if (load.state === "notFound") notFound();
  const header = (
    <ManagePageHeader
      title={t("lesson.editTitle")}
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
  if (!load.editable.course) notFound();
  return (
    <div className="space-y-8">
      {header}
      <TrainingLessonEditor
        key={lesson}
        editable={load.editable}
        course={load.editable.course}
        access={access}
        timeZone={appTimeZone()}
      />
      <PreviewSection>
        <LessonPreview editable={load.editable} />
      </PreviewSection>
    </div>
  );
}
