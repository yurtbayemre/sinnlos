import { useTranslations } from "next-intl";
import type { CourseEditable, LessonEditable } from "@sinnlos/domain";
import { Markdown } from "@/components/markdown";
import { LessonVideo } from "@/components/training/lesson-video";
import { mediaUrl } from "@/lib/config";

export function CoursePreview({ editable }: { editable: CourseEditable }) {
  const t = useTranslations("manage.training");
  const image = editable.coverImage ? mediaUrl(editable.coverImage.url) : null;
  return (
    <article className="space-y-4">
      {image && (
        // Session-gated uploads need the browser cookie; the image optimizer does not forward it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="aspect-video w-full max-w-2xl rounded-xl object-cover" />
      )}
      <h3 className="text-xl font-semibold">{editable.title}</h3>
      <p className="text-sm text-muted-foreground">
        {t(`modes.${editable.completionMode}`)}
        {editable.mandatory ? ` · ${t("fields.mandatory.label")}` : ""}
      </p>
      {editable.description && (
        <Markdown className="prose prose-sm max-w-none dark:prose-invert">
          {editable.description}
        </Markdown>
      )}
    </article>
  );
}
export function LessonPreview({ editable }: { editable: LessonEditable }) {
  const t = useTranslations("manage.training.quiz");
  return (
    <article className="space-y-4">
      <h3 className="text-xl font-semibold">{editable.title}</h3>
      <LessonVideo videoUrl={editable.videoUrl} />
      {editable.body && (
        <Markdown className="prose prose-sm max-w-none dark:prose-invert">{editable.body}</Markdown>
      )}
      <ol className="space-y-4">
        {editable.quiz.map((question, index) => (
          <li key={index} className="rounded-xl border p-4">
            <p className="font-medium">{question.question}</p>
            <ol className="mt-2 list-inside list-decimal space-y-1">
              {question.options.map((option, i) => (
                <li key={i}>
                  {option}
                  {i === question.correctIndex && (
                    <span className="ml-2 text-sm text-muted-foreground">({t("correct")})</span>
                  )}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </article>
  );
}
