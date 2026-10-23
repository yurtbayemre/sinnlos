import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { lessonReceiptState, zonedDateKey } from "@sinnlos/domain";

import { Markdown } from "@/components/markdown";
import { LessonCompletion } from "@/components/training/lesson-completion";
import { LessonVideo } from "@/components/training/lesson-video";
import { FetchErrorBanner } from "@/components/fetch-error";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { appTimeZone } from "@/lib/app-time-zone";
import { formatDateOnly, formatInstant, LONG_DAY } from "@/lib/date-format";
import { isReadDenied } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourseBySlug, fetchLessonByDocumentId, fetchMyProgress } from "@/lib/training";
import { sortLessons } from "@/lib/training-shared";
import { getViewer } from "@/lib/viewer";

/**
 * Lesson player (issue #29): markdown body (the shared renderer of the
 * wiki, components/markdown.tsx — react-markdown + gfm, NO rehype-raw ⇒ no
 * raw HTML/XSS, unsafe URL schemes dropped), the YouTube render gate, the
 * quiz and the completion button, which a quiz locks until every answer
 * is right (issue #70; the cms checks the answers too). PDFs/documents
 * are linked inside the markdown (documents module decision) — no
 * attachment UI.
 */
export default async function LessonPage({
  params,
}: {
  params: Promise<{ slug: string; lessonId: string }>;
}) {
  const { slug, lessonId } = await params;
  const [t, format, viewer] = await Promise.all([
    getTranslations("training"),
    getFormatter(),
    getViewer(),
  ]);
  // A role without the training reads (guest) gets no request and an
  // explanation instead of the error banner (SH02).
  if (isReadDenied(viewer.role, "training")) {
    return <SectionUnavailablePage title={t("title")} />;
  }

  const [lessonResult, courseResult, progressResult] = await Promise.all([
    tryFetch(() => fetchLessonByDocumentId(lessonId), "training"),
    tryFetch(() => fetchCourseBySlug(slug), "training"),
    tryFetch(() => fetchMyProgress(), "training"),
  ]);
  // progressResult.failed included since the quiz-gate: a silently
  // missing progress row would RE-LOCK an already-completed quizGate
  // lesson behind the quiz (review find) — honest banner instead.
  if (lessonResult.failed || courseResult.failed || progressResult.failed) {
    return (
      <div className="space-y-6">
        <FetchErrorBanner />
      </div>
    );
  }
  const lesson = lessonResult.data;
  const course = courseResult.data;
  // The lesson must belong to the course in the URL — a mismatched pair
  // (guessed documentId under a foreign slug) is a plain 404.
  if (!lesson || !course || lesson.course?.documentId !== course.documentId) notFound();

  const lessons = sortLessons(course.lessons ?? []);
  const index = lessons.findIndex((l) => l.documentId === lesson.documentId);
  const next = index >= 0 ? lessons[index + 1] : undefined;
  const completed = progressResult.data?.completed;
  const completedAtIso = completed?.get(lessonId) ?? null;
  const timeZone = appTimeZone();
  const receipt = lessonReceiptState(
    completedAtIso,
    completed?.has(lessonId) ?? false,
    course.validityMonths,
    zonedDateKey(new Date(), timeZone),
    timeZone,
  );
  // Due within the renewal window or overdue (v0.20): complete it again.
  const renew = (completed?.has(lessonId) ?? false) && receipt.mayComplete;
  // An instant, shown as its day in APP_TIME_ZONE (next-intl's formatter).
  const completedAtLabel = renew ? null : formatInstant(format, completedAtIso, LONG_DAY);
  const dueLabel = formatDateOnly(await getLocale(), receipt.dueKey, LONG_DAY);

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/training/${course.slug}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {course.title}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{lesson.title}</h1>
        {index >= 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("lessonPosition", { current: index + 1, total: lessons.length })}
          </p>
        )}
      </div>

      <LessonVideo videoUrl={lesson.videoUrl} />

      {lesson.body && <Markdown headingAnchors>{lesson.body}</Markdown>}

      {renew && dueLabel && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          {receipt.counts
            ? t("renewSoon", { date: dueLabel })
            : t("renewOverdue", { date: dueLabel })}
        </p>
      )}

      {/* A refreshed question set or mode must clear feedback from the previous render. */}
      <LessonCompletion
        key={JSON.stringify([
          lesson.documentId,
          lesson.quiz,
          lesson.course.completionMode,
          completedAtIso,
          lesson.version,
        ])}
        quiz={lesson.quiz}
        completionMode={lesson.course.completionMode}
        lessonDocumentId={lessonId}
        version={lesson.version}
        completedAtLabel={completedAtLabel}
        nextHref={
          next?.documentId ? (`/training/${course.slug}/${next.documentId}` as Route) : null
        }
      />
    </article>
  );
}
