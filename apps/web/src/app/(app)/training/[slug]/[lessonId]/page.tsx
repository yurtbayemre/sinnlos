import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

import { CompleteLessonButton } from "@/components/training/complete-lesson-button";
import { LessonVideo } from "@/components/training/lesson-video";
import { QuizBlock } from "@/components/training/quiz-block";
import { FetchErrorBanner } from "@/components/fetch-error";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourseBySlug, fetchLessonByDocumentId, fetchMyProgress } from "@/lib/training";
import { parseQuiz, sortLessons } from "@/lib/training-shared";

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
  const [t, locale] = await Promise.all([getTranslations("training"), getLocale()]);

  const [lessonResult, courseResult, progressResult] = await Promise.all([
    tryFetch(() => fetchLessonByDocumentId(lessonId), "training"),
    tryFetch(() => fetchCourseBySlug(slug), "training"),
    tryFetch(() => fetchMyProgress(), "training"),
  ]);
  if (lessonResult.failed || courseResult.failed) {
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
  const completedAtLabel = completedAtIso
    ? new Date(completedAtIso).toLocaleDateString(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;
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

      <QuizBlock quiz={quiz} />

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <CompleteLessonButton
          lessonDocumentId={lessonId}
          completedAtLabel={completedAtLabel}
        />
        {next?.documentId && (
          <Link
            href={`/training/${course.slug}/${next.documentId}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t("nextLesson")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </footer>
    </article>
  );
}
