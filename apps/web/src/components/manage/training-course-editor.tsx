"use client";

import { useCallback, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { UPLOAD_FILE_KEY, type CourseEditable, type UploadFileCode } from "@sinnlos/domain";
import { startCmsAction } from "@/lib/action-result";
import type { AreaAccess } from "@/lib/manage/access";
import { fieldInputId, knownCode } from "@/lib/manage/errors";
import {
  saveCourse,
  publishCourse,
  unpublishCourse,
  discardCourse,
} from "@/lib/manage/training-actions";
import {
  courseValuesFromEditable,
  emptyCourseValues,
  type CourseValues,
} from "@/lib/manage/training-values";
import { uploadImageFile } from "@/lib/manage/upload";
import { checkUploadFile } from "@/lib/manage/upload-check";
import { scheduleValuesFromEditable, type ScheduleValues } from "@/lib/manage/values";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import { CheckboxField, CheckboxList, Field, inputClass } from "./form-controls";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { BackToList, OptionsNotice, RetargetNotice, Section } from "./editor-parts";
import { FileField } from "./file-field";
import { MarkdownEditor } from "./markdown-editor";
import { SinglePicker } from "./pickers";
import { PublishBar, type PublishBarHandlers } from "./publish-bar";
import { ScheduleDialog } from "./schedule-dialog";
import type { EditorIntent } from "./use-authoring-editor";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "course";
const FIELD_ORDER = [
  "title",
  "description",
  "mandatory",
  "completionMode",
  "validityMonths",
  "contact",
  "coverImage",
  "departments",
  "publishAt",
] as const;
const ACTIONS: ItemActions = {
  save: saveCourse,
  publish: publishCourse,
  unpublish: unpublishCourse,
  discard: discardCourse,
};

export function TrainingCourseEditor({
  editable,
  access,
  timeZone,
  departments,
  optionsFailed,
  optionsTruncated,
}: {
  editable: CourseEditable | null;
  access: AreaAccess;
  timeZone: string;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
}) {
  const t = useTranslations("manage.training");
  const tc = useTranslations("manage.common");
  const [picked, setPicked] = useState<File | null>(null);
  const [pickError, setPickError] = useState<UploadFileCode | null>(null);
  const [uploading, startUpload] = useTransition();
  const [uploadIntent, setUploadIntent] = useState<EditorIntent | null>(null);
  const dropPick = useCallback(() => {
    setPicked(null);
    setPickError(null);
  }, []);
  const item = useItemEditor<CourseValues, CourseEditable>({
    area: "courses",
    formId: FORM_ID,
    editable,
    toValues: courseValuesFromEditable,
    emptyValues: emptyCourseValues(),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
    extraDirty: picked !== null,
    busy: uploading,
    onReset: dropPick,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("courses", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const pending = editor.pending;
  const withUpload = (intent: EditorIntent, save: (override?: Partial<CourseValues>) => void) => {
    if (!picked) {
      save();
      return;
    }
    const leaveDialog = () => {
      if (intent === "schedule") item.leaveSchedule();
    };
    const early = checkUploadFile(picked, true);
    if (early) {
      leaveDialog();
      editor.refuse({ coverImage: early });
      return;
    }
    const form = new FormData();
    form.append(UPLOAD_FILE_KEY, picked);
    setPickError(null);
    setUploadIntent(intent);
    startCmsAction(startUpload, {
      action: () => uploadImageFile(form),
      onSuccess: (uploaded) => {
        if (!uploaded) {
          leaveDialog();
          editor.fail("failed");
          return;
        }
        setPicked(null);
        setValue("coverImage", uploaded);
        save({ coverImage: uploaded });
      },
      onFailure: (code, failure) => {
        leaveDialog();
        if (code === "invalid" && failure.fields?.file)
          editor.refuse({ coverImage: knownCode(failure.fields.file) });
        else editor.fail(code);
      },
      onSettled: () => setUploadIntent(null),
    });
  };
  const handlers: PublishBarHandlers = {
    ...item.handlers,
    saveDraft: () =>
      withUpload(editor.meta ? "saveDraft" : "create", (override) =>
        item.save("draft", undefined, override),
      ),
    saveAndPublish: () =>
      withUpload("saveAndPublish", (override) => item.save("published", undefined, override)),
  };
  const saveSchedule = (schedule: ScheduleValues) =>
    withUpload("schedule", (override) => item.save("draft", schedule, override));
  return (
    <>
      <form
        id={FORM_ID}
        noValidate
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          handlers.saveDraft();
        }}
      >
        <EditorStatus meta={editor.meta} dirty={item.dirty} showOwner={false} />
        <Section title={t("course.section")}>
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
            id={id("description")}
            label={t("fields.description.label")}
            error={error("description")}
            value={values.description}
            disabled={pending}
            onChange={(value) => setValue("description", value)}
          />
          <CheckboxField
            id={id("mandatory")}
            label={t("fields.mandatory.label")}
            checked={values.mandatory}
            disabled={pending}
            error={error("mandatory")}
            onChange={(value) => setValue("mandatory", value)}
          />
          <SinglePicker
            id={id("completionMode")}
            label={t("fields.completionMode.label")}
            error={error("completionMode")}
            value={values.completionMode}
            options={(["confirm", "quizGate", "exam"] as const).map((mode) => ({
              value: mode,
              label: t(`modes.${mode}`),
            }))}
            disabled={pending}
            onChange={(mode) => setValue("completionMode", mode)}
          />
          <p className="text-sm text-muted-foreground">{t("modeHint")}</p>
          <p className="rounded-xl border bg-muted/30 p-3 text-sm">{t("receiptsNotice")}</p>
          <Field
            id={id("validityMonths")}
            label={t("fields.validityMonths.label")}
            hint={t("fields.validityMonths.hint")}
            error={error("validityMonths")}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="number"
                inputMode="numeric"
                min={1}
                max={120}
                value={values.validityMonths}
                disabled={pending}
                onChange={(e) => setValue("validityMonths", e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field
            id={id("contact")}
            label={t("fields.contact.label")}
            hint={t("fields.contact.hint")}
            error={error("contact")}
          >
            {(a11y) => (
              <input
                {...a11y}
                value={values.contact}
                maxLength={255}
                disabled={pending}
                onChange={(e) => setValue("contact", e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <FileField
            id={id("coverImage")}
            label={t("fields.coverImage.label")}
            hint={t("fields.coverImage.hint")}
            error={error("coverImage") ?? (pickError ? tc(`errors.${pickError}`) : undefined)}
            imageOnly
            current={values.coverImage}
            uploadedForSave={
              (values.coverImage?.id ?? null) !== (item.initial.coverImage?.id ?? null)
            }
            picked={picked}
            disabled={pending}
            uploading={uploading}
            onPick={(file) => {
              const code = checkUploadFile(file, true);
              setPickError(code);
              setPicked(code ? null : file);
            }}
            onCancelPick={dropPick}
            onRemove={() => {
              dropPick();
              setValue("coverImage", null);
            }}
          />
        </Section>
        <Section title={t("sections.audience")}>
          {editable?.needsRetarget && (
            <RetargetNotice
              checked={item.retarget}
              disabled={pending || optionsFailed}
              onChange={item.setRetarget}
            />
          )}
          <OptionsNotice failed={optionsFailed} truncated={optionsTruncated} />
          <CheckboxList
            id={id("departments")}
            legend={t("fields.departments.label")}
            hint={t("fields.departments.hint")}
            error={error("departments")}
            options={departments.map((d) => ({ value: d.documentId, label: d.name }))}
            selected={values.departments}
            disabled={pending || optionsFailed}
            emptyText={tc("targeting.noneAvailable")}
            onChange={(selected) => setValue("departments", selected)}
          />
        </Section>
        <FormAlert area="courses" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="courses"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={pending}
          running={uploadIntent ?? editor.running}
          handlers={handlers}
          onInvoke={editor.rememberInvoker}
        >
          <BackToList area="courses" />
        </PublishBar>
      </form>
      {access.verbs.includes("schedule") && (
        <ScheduleDialog
          area="courses"
          formId={FORM_ID}
          open={item.scheduleOpen}
          initial={scheduleValuesFromEditable(editor.meta ?? {}, timeZone)}
          hasSchedule={!!editor.meta?.publishAt}
          timeZone={timeZone}
          pending={pending}
          errorText={error}
          returnFocus={item.scheduleOpener}
          onOpenChange={item.setScheduleOpen}
          onSave={saveSchedule}
        />
      )}
      <ConflictDialog
        conflict={editor.conflict}
        copyText={[values.title, values.description].filter(Boolean).join("\n\n")}
        pending={pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
