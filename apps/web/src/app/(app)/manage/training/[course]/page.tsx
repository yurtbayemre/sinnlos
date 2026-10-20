import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { TrainingCourseEditor } from "@/components/manage/training-course-editor";
import { CoursePreview } from "@/components/manage/training-previews";
import { PreviewSection } from "@/components/manage/previews";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { areaGate } from "@/lib/manage/page-gate";
import { lessonListPath } from "@/lib/manage/training-paths";
import { loadCourseEditable } from "@/lib/loaders/manage/training";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";
import { appTimeZone } from "@/lib/app-time-zone";

export async function generateMetadata() {
  const t = await getTranslations("manage.training");
  return { title: t("course.editTitle") };
}
export default async function EditCoursePage({ params }: { params: Promise<{ course: string }> }) {
  const { access } = await areaGate("courses", "edit");
  const { course } = await params;
  const t = await getTranslations("manage.training");
  const [load, options] = await Promise.all([
    loadCourseEditable(course),
    loadTargetingOptions({ departments: true, teams: false }),
  ]);
  if (load.state === "notFound") notFound();
  const header = (
    <ManagePageHeader
      title={t("course.editTitle")}
      back="/manage/training"
      backLabel={t("title")}
      action={
        load.state === "ok" ? { href: lessonListPath(course), label: t("lesson.title") } : undefined
      }
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
      <TrainingCourseEditor
        key={course}
        editable={load.editable}
        access={access}
        timeZone={appTimeZone()}
        departments={options.departments}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
      <PreviewSection>
        <CoursePreview editable={load.editable} />
      </PreviewSection>
    </div>
  );
}
