import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { CourseStatus } from "@/components/training/course-status";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { Card, CardContent } from "@/components/ui/card";
import { mediaUrl } from "@/lib/config";
import { stripMarkdown } from "@/lib/utils";
import { isReadDenied } from "@/lib/roles";
import { loadTrainingOverview } from "@/lib/loaders/training";
import { getViewer } from "@/lib/viewer";

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
  // A role without the training reads (guest) gets no request and an
  // explanation instead of the CMS's 403 as an error banner (SH02).
  if (isReadDenied((await getViewer()).role, "training")) {
    return (
      <SectionUnavailablePage
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
      />
    );
  }
  const [overview, locale] = await Promise.all([loadTrainingOverview(), getLocale()]);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />

      {overview.failed && <FetchErrorBanner />}

      {overview.empty ? (
        <EmptyState icon={GraduationCap} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="stagger grid gap-4 md:grid-cols-2">
          {overview.courses.map(({ course, total, completed, status, dueKey }) => {
            const coverImage = mediaUrl(
              course.coverImage?.formats?.small?.url ?? course.coverImage?.url,
            );
            return (
              <Link key={course.id} href={`/training/${course.slug}`} className="focus-card">
                <Card interactive className="h-full transition-colors hover:border-primary/40">
                  <CardContent className="flex h-full flex-col gap-3 p-5">
                    {coverImage && (
                      // Authenticated uploads are requested by the browser with its session cookie.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={coverImage}
                        alt=""
                        className="aspect-video w-full rounded-xl object-cover"
                      />
                    )}
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
                        {stripMarkdown(course.description)}
                      </p>
                    )}
                    <div className="mt-auto flex items-center justify-between gap-3 pt-2 text-sm">
                      <span className="text-muted-foreground">
                        {t("lessonCount", { count: total })}
                      </span>
                      <CourseStatus
                        t={t}
                        locale={locale}
                        status={status}
                        dueKey={dueKey}
                        completed={completed}
                        total={total}
                        unknown={overview.statusUnknown}
                      />
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
