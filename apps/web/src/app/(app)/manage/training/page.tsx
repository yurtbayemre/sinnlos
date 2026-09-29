import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, GraduationCap } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatInstant, SHORT_DAY } from "@/lib/date-format";
import { isAdmin } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { fetchCourseProgress, fetchCourses } from "@/lib/training";
import {
  courseLessons,
  trainingReport,
  trainingStaff,
  type CourseProgress,
  type TrainingReportUser,
} from "@/lib/training-report";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("trainingReport");
  return { title: t("title") };
}

type ReportUser = UserLite & TrainingReportUser;

/**
 * Role types holding `course.find` in the CMS permission matrix — only
 * they can take a training, so only they belong in the denominator.
 * `guest` deliberately has NO training grants (issue #29).
 * infra/contracts.test.ts pins this copy against the matrix.
 */
const TRAINING_ROLES = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "authenticated",
]);

/**
 * Completion report per mandatory course (issue #29; clone of
 * /manage/acknowledgements). admin_role bypasses both training policies,
 * so courses include drafts — filtered out here — and progress rows span
 * ALL users. Progress is walked PER COURSE (lib/training.ts
 * fetchCourseProgress) so the walk cap scales with course size, not with
 * the global row count. Fail-closed: any truncated/failed input suppresses
 * the numbers ("–"), never false-green (lib/training-report.ts).
 */
export default async function TrainingReportPage() {
  if (!isAdmin((await getViewer()).role)) {
    redirect("/");
  }

  // `format` renders instants in APP_TIME_ZONE (i18n/request.ts).
  const [t, tAdmin, tTraining, format] = await Promise.all([
    getTranslations("trainingReport"),
    getTranslations("admin"),
    getTranslations("training"),
    getFormatter(),
  ]);

  const [coursesResult, usersResult] = await Promise.all([
    tryFetch(() => fetchCourses(), "training-report"),
    tryFetch(
      () =>
        fetchAllUsers(
          "populate[role]=true&fields[0]=displayName&fields[1]=email&fields[2]=blocked",
        ),
      "training-report",
    ),
  ]);

  if (coursesResult.failed || usersResult.failed) {
    return (
      <div className="space-y-6">
        <BackLink label={tAdmin("title")} />
        <FetchErrorBanner />
      </div>
    );
  }

  // REST default status=published (drafts stay the authors' workbench);
  // the report covers mandatory courses only.
  const courses = coursesResult.data!.courses.filter((c) => c.mandatory);
  const coursesTruncated = coursesResult.data!.truncated;

  const staff = trainingStaff(usersResult.data!.users as ReportUser[], TRAINING_ROLES);
  const usersTruncated = usersResult.data!.truncated;

  // Per-course progress walk, keyed by the course's lesson documentIds
  // (only for courses that have lessons).
  const progress = new Map<number, CourseProgress>(
    await Promise.all(
      courses
        .map((course) => ({ course, lessonIds: courseLessons(course).lessonIds }))
        .filter(({ lessonIds }) => lessonIds.length > 0)
        .map(async ({ course, lessonIds }): Promise<[number, CourseProgress]> => {
          const result = await tryFetch(
            () => fetchCourseProgress(lessonIds, `training-report:${course.slug}`),
            "training-report",
          );
          return [
            course.id,
            result.failed ? null : { rows: result.data!.data, truncated: result.data!.truncated },
          ];
        }),
    ),
  );

  const { rows, anyTruncated, denominator } = trainingReport({
    courses,
    coursesTruncated,
    staff,
    usersTruncated,
    progressOf: (course) => progress.get(course.id) ?? null,
  });

  return (
    <div className="space-y-8">
      <div>
        <BackLink label={tAdmin("title")} />
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("description", { count: denominator })}</p>
      </div>

      {anyTruncated && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <span>{t("truncatedWarning")}</span>
        </div>
      )}

      {courses.length === 0 ? (
        <EmptyState icon={GraduationCap} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="space-y-4">
          {rows.map(({ course, lessonCount, completedUsers, unknown, pct }) => {
            const updated = formatInstant(format, course.updatedAt, SHORT_DAY);
            return (
              <Card key={course.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
                    <Link href={`/training/${course.slug}`} className="hover:underline">
                      {course.title}
                    </Link>
                    <span className="text-sm font-normal text-muted-foreground">
                      {tTraining("lessonCount", { count: lessonCount })}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-4 text-sm">
                  {unknown ? (
                    <span className="text-muted-foreground">–</span>
                  ) : (
                    <>
                      <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        {t("completedOf", { done: completedUsers as number, total: denominator })}
                      </span>
                      <span className="text-muted-foreground">({pct}%)</span>
                      {updated && (
                        <span className="text-xs text-muted-foreground">
                          {t("updatedAt", { date: updated })}
                        </span>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/manage"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}
