import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { GraduationCap } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { TrainingReportCourse } from "@sinnlos/domain";
import { trainingReport } from "@/lib/api/training";
import { capabilitiesFor, isAdmin } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { getViewer } from "@/lib/viewer";
import { EmptyState } from "@/components/empty-state";
import { AdminPageHeader } from "@/components/admin-page-header";
import { FetchErrorBanner } from "@/components/fetch-error";
import { NoDepartmentExplanation } from "@/components/manage/page-parts";
import { ReportCounts } from "@/components/manage/training-report";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("trainingReport");
  return { title: t("title") };
}

/**
 * The named training report (v0.20; owner decision 2026-10-20): one card per
 * mandatory course with who is valid, due soon, expired or open. The cms
 * scopes the answer (GET /api/courses/report): admin_role sees everyone,
 * department heads and team leads the people of their own department. A head
 * or lead without a department gets the explanation instead of a 403 banner.
 */
export default async function TrainingReportPage() {
  const viewer = await getViewer();
  if (!capabilitiesFor(viewer.role).reports.training) redirect("/");

  const [t, tTraining] = await Promise.all([
    getTranslations("trainingReport"),
    getTranslations("training"),
  ]);
  if (!isAdmin(viewer.role) && !viewer.department) {
    return (
      <div className="space-y-8">
        <AdminPageHeader title={t("title")} />
        <NoDepartmentExplanation />
      </div>
    );
  }

  const result = await tryFetch(() => trainingReport(), "training-report");
  if (result.failed) {
    return (
      <div className="space-y-8">
        <AdminPageHeader title={t("title")} />
        <FetchErrorBanner />
      </div>
    );
  }
  const { scope, department, courses } = result.data!.data;

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title={t("title")}
        description={
          scope === "all" ? t("scopeAll") : t("scopeDepartment", { department: department ?? "" })
        }
      />
      {courses.length === 0 ? (
        <EmptyState icon={GraduationCap} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="space-y-4">
          {courses.map((course) => (
            <CourseCard
              key={course.documentId}
              course={course}
              lessonCount={tTraining("lessonCount", { count: course.lessonCount })}
              validity={
                course.validityMonths
                  ? t("validityEvery", { count: course.validityMonths })
                  : t("validityOnce")
              }
              audience={course.departments.join(", ") || t("allEmployees")}
              showPeople={t("showPeople")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CourseCard({
  course,
  lessonCount,
  validity,
  audience,
  showPeople,
}: {
  course: TrainingReportCourse;
  lessonCount: string;
  validity: string;
  audience: string;
  showPeople: string;
}) {
  const href = `/manage/training/report/${course.documentId}` as Route;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex flex-wrap items-center justify-between gap-3 text-base">
          <Link href={href} className="hover:underline">
            {course.title}
          </Link>
          <span className="text-sm font-normal text-muted-foreground">
            {lessonCount} · {validity} · {audience}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 text-sm">
        <ReportCounts counts={course.counts} />
        <Link href={href} className="text-sm font-medium text-primary hover:underline">
          {showPeople}
        </Link>
      </CardContent>
    </Card>
  );
}
