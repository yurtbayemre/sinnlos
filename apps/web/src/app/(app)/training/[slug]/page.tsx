import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/page-header";
import { SectionUnavailable } from "@/components/section-unavailable";
import { Card, CardContent } from "@/components/ui/card";
import { isReadDenied } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourseBySlug, fetchMyProgress } from "@/lib/training";
import { courseCompletion, sortLessons } from "@/lib/training-shared";
import { getViewer } from "@/lib/viewer";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const t = await getTranslations("training");
  // No read for a role without the training reads (SH02).
  if (isReadDenied((await getViewer()).role, "training")) return { title: t("title") };
  // Same GET as the page's, sent once per render (Next's fetch dedupe).
  const { data } = await tryFetch(() => fetchCourseBySlug(slug), "course-meta");
  return { title: data?.title ?? t("title") };
}

/**
 * Course detail: ordered lesson list with per-lesson completion state
 * and a "continue" CTA pointing at the first open lesson (issue #29).
 *
 * Detail-page error strategy (WD07, same on all detail pages): an unknown
 * course is a 404; a failed course read goes to (app)/error.tsx, whose
 * "Try again" fetches the page again. The caller's progress is secondary:
 * without it the status shows "–".
 */
export default async function CoursePage({ params }: Params) {
  const { slug } = await params;
  const t = await getTranslations("training");
  // A role without the training reads (guest) gets no request and an
  // explanation instead of the error page (SH02).
  if (isReadDenied((await getViewer()).role, "training")) {
    return (
      <div className="space-y-8">
        <PageHeader title={t("title")} />
        <SectionUnavailable />
      </div>
    );
  }

  const [course, progressResult] = await Promise.all([
    fetchCourseBySlug(slug),
    tryFetch(() => fetchMyProgress(), "training"),
  ]);
  if (!course) notFound();

  const lessons = sortLessons(course.lessons ?? []);
  const completed = new Set(progressResult.data?.completed.keys() ?? []);
  const statusUnknown = progressResult.failed || (progressResult.data?.truncated ?? true);
  const { total, completed: doneCount, done } = courseCompletion(lessons, completed);
  const firstOpen = lessons.find((l) => l.documentId && !completed.has(l.documentId));

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/training"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("title")}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{course.title}</h1>
          {course.mandatory && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
              {t("mandatory")}
            </span>
          )}
        </div>
        {course.description && <p className="mt-1 text-muted-foreground">{course.description}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
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
          {firstOpen?.documentId && (
            <Link
              href={`/training/${course.slug}/${firstOpen.documentId}`}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {doneCount > 0 ? t("continueCourse") : t("startCourse")}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="divide-y p-0">
          {lessons.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground">{t("noLessons")}</div>
          )}
          {lessons.map((lesson, index) => {
            const isDone = !!lesson.documentId && completed.has(lesson.documentId);
            return (
              <Link
                key={lesson.id}
                href={`/training/${course.slug}/${lesson.documentId}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                {isDone ? (
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="text-sm">
                  <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                  {lesson.title}
                </span>
              </Link>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
