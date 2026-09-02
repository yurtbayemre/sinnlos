import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, GraduationCap } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { walkAllPages } from "@/lib/paginate";
import { fetchCourses } from "@/lib/training";
import { courseCompletion, sortLessons } from "@/lib/training-shared";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import type { LessonProgress, UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("trainingReport");
  return { title: t("title") };
}

type ReportUser = UserLite & {
  role?: { id: number; type?: string } | null;
  blocked?: boolean;
};

/**
 * Role types holding `course.find` in the CMS permission matrix — only
 * they can take a training, so only they belong in the denominator.
 * `guest` deliberately has NO training grants (issue #29).
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
 * ALL users. Progress is walked PER COURSE via `targetDocumentId $in
 * <lesson ids>` (the events.rsvps pattern) so the walk cap scales with
 * course size, not with the global row count. Fail-closed: any
 * truncated/failed input suppresses the numbers ("–"), never false-green.
 */
export default async function TrainingReportPage() {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    redirect("/");
  }

  const [t, tAdmin, tTraining, locale] = await Promise.all([
    getTranslations("trainingReport"),
    getTranslations("admin"),
    getTranslations("training"),
    getLocale(),
  ]);

  const [coursesResult, usersResult] = await Promise.all([
    tryFetch(() => fetchCourses(), "training-report"),
    tryFetch(() => fetchAllUsers("populate[role]=true&fields[0]=displayName&fields[1]=email&fields[2]=blocked"), "training-report"),
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

  const staff = (usersResult.data!.users as ReportUser[]).filter(
    (u) => u.blocked !== true && TRAINING_ROLES.has(u.role?.type ?? ""),
  );
  const usersTruncated = usersResult.data!.truncated;

  // Per-course progress walk, keyed by the course's lesson documentIds.
  const rows = await Promise.all(
    courses.map(async (course) => {
      const lessons = sortLessons(course.lessons ?? []);
      const lessonIds = lessons
        .map((l) => l.documentId)
        .filter((id): id is string => typeof id === "string" && id !== "");
      if (lessonIds.length === 0) {
        return { course, lessonCount: 0, completedUsers: 0, truncated: false };
      }
      const filter = lessonIds
        .map((id, i) => `filters[targetDocumentId][$in][${i}]=${encodeURIComponent(id)}`)
        .join("&");
      const progressResult = await tryFetch(
        () =>
          walkAllPages<LessonProgress>(
            (page) =>
              strapi<StrapiListResponse<LessonProgress>>(
                `/api/lesson-progresses?${filter}&fields[0]=targetDocumentId&populate[user][fields][0]=id&pagination[page]=${page}&pagination[pageSize]=100`,
                { noCache: true },
              ),
            { maxPages: 20, label: `training-report:${course.slug}` },
          ),
        "training-report",
      );
      if (progressResult.failed) {
        return { course, lessonCount: lessonIds.length, completedUsers: null, truncated: true };
      }

      // userId → set of completed lesson ids; a user counts as done when
      // the set covers the course's CURRENT lessons (same derivation as
      // the learner UI — inherently idempotent against duplicate rows).
      const byUser = new Map<number, Set<string>>();
      for (const row of progressResult.data!.data) {
        const uid = row.user?.id;
        if (typeof uid !== "number" || typeof row.targetDocumentId !== "string") continue;
        if (!byUser.has(uid)) byUser.set(uid, new Set());
        byUser.get(uid)!.add(row.targetDocumentId);
      }
      let completedUsers = 0;
      for (const u of staff) {
        const set = byUser.get(u.id) ?? new Set<string>();
        if (courseCompletion(lessons, set).done) completedUsers++;
      }
      return {
        course,
        lessonCount: lessonIds.length,
        completedUsers,
        truncated: progressResult.data!.truncated,
      };
    }),
  );

  const anyTruncated = coursesTruncated || usersTruncated || rows.some((r) => r.truncated);
  const denominator = staff.length;

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
          {rows.map(({ course, lessonCount, completedUsers, truncated }) => {
            const unknown = truncated || completedUsers === null || anyTruncated;
            const pct =
              !unknown && denominator > 0
                ? Math.round(((completedUsers as number) / denominator) * 100)
                : null;
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
                      {course.updatedAt && (
                        <span className="text-xs text-muted-foreground">
                          {t("updatedAt", {
                            date: new Date(course.updatedAt).toLocaleDateString(locale, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            }),
                          })}
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
