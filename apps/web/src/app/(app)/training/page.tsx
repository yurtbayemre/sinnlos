import Link from "next/link";
import { CheckCircle2, GraduationCap } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourses, fetchMyProgress } from "@/lib/training";
import { courseCompletion } from "@/lib/training-shared";

export async function generateMetadata() {
  const t = await getTranslations("training");
  return { title: t("title") };
}

/**
 * Course overview with per-user completion status (issue #29). Courses
 * are admin-authored; the CMS training-visibility policy already limits
 * this list to published courses (drafts stay the authors' workbench).
 * Status is DERIVED from the caller's own progress rows — fail-closed:
 * truncated fetches show "unknown" instead of a false green.
 */
export default async function TrainingPage() {
  const t = await getTranslations("training");
  const [coursesResult, progressResult] = await Promise.all([
    tryFetch(() => fetchCourses(), "training"),
    tryFetch(() => fetchMyProgress(), "training"),
  ]);
  const failed = coursesResult.failed || progressResult.failed;
  const courses = coursesResult.data?.courses ?? [];
  const statusUnknown =
    failed || (progressResult.data?.truncated ?? true) || (coursesResult.data?.truncated ?? true);
  const completed = new Set(progressResult.data?.completed.keys() ?? []);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />

      {failed && <FetchErrorBanner />}

      {courses.length === 0 ? (
        <EmptyState icon={GraduationCap} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="stagger grid gap-4 md:grid-cols-2">
          {courses.map((course) => {
            const { total, completed: doneCount, done } = courseCompletion(
              course.lessons ?? [],
              completed,
            );
            return (
              <Link key={course.id} href={`/training/${course.slug}`} className="focus-card">
                <Card className="h-full transition-colors hover:border-primary/40">
                  <CardContent className="flex h-full flex-col gap-3 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-medium leading-snug">{course.title}</h2>
                      {course.mandatory && (
                        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                          {t("mandatory")}
                        </span>
                      )}
                    </div>
                    {course.description && (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {course.description}
                      </p>
                    )}
                    <div className="mt-auto flex items-center justify-between gap-3 pt-2 text-sm">
                      <span className="text-muted-foreground">
                        {t("lessonCount", { count: total })}
                      </span>
                      {statusUnknown ? (
                        <span className="text-muted-foreground">–</span>
                      ) : done ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          {t("statusDone")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t("statusProgress", { done: doneCount, total })}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
