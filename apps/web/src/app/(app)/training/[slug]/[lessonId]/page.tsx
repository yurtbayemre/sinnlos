import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

import { LessonCompletion } from "@/components/training/lesson-completion";
import { LessonVideo } from "@/components/training/lesson-video";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailable } from "@/components/section-unavailable";
import { formatInstant, LONG_DAY } from "@/lib/date-format";
import { isReadDenied } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourseBySlug, fetchLessonByDocumentId, fetchMyProgress } from "@/lib/training";
import { parseQuiz, sortLessons, type CompletionMode } from "@/lib/training-shared";
import { getViewer } from "@/lib/viewer";

/**
 * Lesson player (issue #29): markdown body (same pipeline as the wiki —
 * react-markdown + gfm, NO rehype-raw ⇒ no raw HTML/XSS), the YouTube
 * render gate, the client-only self-check quiz and the completion
 * button. PDFs/documents are linked inside the markdown (documents
 * module decision) — no attachment UI.
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
    return (
      <div className="space-y-8">
        <PageHeader title={t("title")} />
        <SectionUnavailable />
      </div>
    );
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
  const completedAtIso = progressResult.data?.completed.get(lessonId) ?? null;
  // An instant, shown as its day in APP_TIME_ZONE (next-intl's formatter).
  const completedAtLabel = formatInstant(format, completedAtIso, LONG_DAY);
  const quiz = parseQuiz(lesson.quiz);

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

      {lesson.body && (
        <div className="prose prose-slate max-w-none dark:prose-invert">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }]]}
          >
            {lesson.body}
          </ReactMarkdown>
        </div>
      )}

      <LessonCompletion
        quiz={quiz}
        completionMode={(course.completionMode ?? "confirm") as CompletionMode}
        lessonDocumentId={lessonId}
        completedAtLabel={completedAtLabel}
        nextHref={
          next?.documentId ? (`/training/${course.slug}/${next.documentId}` as Route) : null
        }
      />
    </article>
  );
}
