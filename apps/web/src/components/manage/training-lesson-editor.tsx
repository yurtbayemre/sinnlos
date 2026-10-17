"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { LessonEditable, TrainingCourseRef } from "@sinnlos/domain";
import { buttonVariants } from "@/components/ui/button";
import type { AreaAccess } from "@/lib/manage/access";
import { fieldInputId } from "@/lib/manage/errors";
import {
  saveLesson,
  publishLesson,
  unpublishLesson,
  discardLesson,
} from "@/lib/manage/training-actions";
import { lessonListPath, lessonPath } from "@/lib/manage/training-paths";
import {
  emptyLessonValues,
  lessonValuesFromEditable,
  type LessonValues,
} from "@/lib/manage/training-values";
import { scheduleValuesFromEditable } from "@/lib/manage/values";
import { Field, inputClass } from "./form-controls";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { Section } from "./editor-parts";
import { MarkdownEditor } from "./markdown-editor";
import { PublishBar } from "./publish-bar";
import { QuizBuilder } from "./quiz-builder";
import { ScheduleDialog } from "./schedule-dialog";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "lesson";
const FIELD_ORDER = ["title", "body", "order", "course", "videoUrl", "quiz", "publishAt"] as const;
const ACTIONS: ItemActions = {
  save: saveLesson,
  publish: publishLesson,
  unpublish: unpublishLesson,
  discard: discardLesson,
};

export function TrainingLessonEditor({
  editable,
  course,
  access,
  timeZone,
}: {
  editable: LessonEditable | null;
  course: TrainingCourseRef;
  access: AreaAccess;
  timeZone: string;
}) {
  const t = useTranslations("manage.training");
  const item = useItemEditor<LessonValues, LessonEditable>({
    area: "lessons",
    formId: FORM_ID,
    editable,
    toValues: lessonValuesFromEditable,
    emptyValues: emptyLessonValues(course.documentId),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
    itemPath: (data) => lessonPath(course.documentId, data.documentId),
    listPath: lessonListPath(course.documentId),
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("lessons", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const pending = editor.pending;
  return (
    <>
      <form
        id={FORM_ID}
        noValidate
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          item.handlers.saveDraft();
        }}
      >
        <EditorStatus meta={editor.meta} dirty={item.dirty} showOwner={false} />
        <Section title={t("lesson.section")}>
          <Field
            id={id("course")}
            label={t("fields.course.label")}
            hint={t("fields.course.hint")}
            error={error("course")}
          >
            {(a11y) => <input {...a11y} readOnly value={course.title} className={inputClass} />}
          </Field>
          <Field id={id("title")} label={t("fields.title.label")} error={error("title")} required>
            {(a11y) => (
              <input
                {...a11y}
                value={values.title}
                disabled={pending}
                onChange={(e) => setValue("title", e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <MarkdownEditor
            id={id("body")}
            label={t("fields.body.label")}
            error={error("body")}
            value={values.body}
            disabled={pending}
            onChange={(body) => setValue("body", body)}
          />
          <Field
            id={id("order")}
            label={t("fields.order.label")}
            hint={t("fields.order.hint")}
            error={error("order")}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="number"
                min={0}
                max={10000}
                step={1}
                inputMode="numeric"
                value={values.order}
                disabled={pending}
                onChange={(e) => setValue("order", e.target.value)}
                className={`${inputClass} sm:max-w-40`}
              />
            )}
          </Field>
          <Field
            id={id("videoUrl")}
            label={t("fields.videoUrl.label")}
            hint={t("fields.videoUrl.hint")}
            error={error("videoUrl")}
          >
            {(a11y) => (
              <input
                {...a11y}
                inputMode="url"
                value={values.videoUrl}
                disabled={pending}
                onChange={(e) => setValue("videoUrl", e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        </Section>
        <Section title={t("quiz.title")} description={t("receiptsNotice")}>
          <QuizBuilder
            id={id("quiz")}
            value={values.quiz}
            error={error("quiz")}
            disabled={pending}
            onChange={(quiz) => setValue("quiz", quiz)}
          />
        </Section>
        <FormAlert area="lessons" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="lessons"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={pending}
          running={editor.running}
          handlers={item.handlers}
          onInvoke={editor.rememberInvoker}
        >
          <Link
            href={lessonListPath(course.documentId)}
            className={buttonVariants({ variant: "ghost" })}
          >
            {t("lesson.title")}
          </Link>
        </PublishBar>
      </form>
      {access.verbs.includes("schedule") && (
        <ScheduleDialog
          area="lessons"
          formId={FORM_ID}
          open={item.scheduleOpen}
          initial={scheduleValuesFromEditable(editor.meta ?? {}, timeZone)}
          hasSchedule={!!editor.meta?.publishAt}
          timeZone={timeZone}
          pending={pending}
          errorText={error}
          returnFocus={item.scheduleOpener}
          onOpenChange={item.setScheduleOpen}
          onSave={(schedule) => item.save("draft", schedule)}
        />
      )}
      <ConflictDialog
        conflict={editor.conflict}
        copyText={[values.title, values.body, JSON.stringify(values.quiz, null, 2)].join("\n\n")}
        pending={pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
