"use client";

import { useCallback, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  DOCUMENT_CATEGORIES,
  UPLOAD_FILE_KEY,
  type DocumentEditable,
  type UploadFileCode,
} from "@sinnlos/domain";
import { startCmsAction } from "@/lib/action-result";
import type { AreaAccess } from "@/lib/manage/access";
import {
  deleteDocument,
  discardDocument,
  publishDocument,
  saveDocument,
  unpublishDocument,
} from "@/lib/manage/document-actions";
import { fieldInputId, sortFieldErrors } from "@/lib/manage/errors";
import { uploadDocumentFile } from "@/lib/manage/upload";
import { checkUploadFile } from "@/lib/manage/upload-check";
import {
  documentValuesFromEditable,
  emptyDocumentValues,
  scheduleValuesFromEditable,
  type DocumentValues,
  type ScheduleValues,
} from "@/lib/manage/values";
import { cn } from "@/lib/utils";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import { CheckboxList, Field, inputClass, textareaClass } from "./form-controls";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import {
  BackToList,
  OptionsNotice,
  PinnedDepartment,
  RetargetNotice,
  Section,
} from "./editor-parts";
import { FileField } from "./file-field";
import { SinglePicker } from "./pickers";
import { PublishBar, type PublishBarHandlers } from "./publish-bar";
import { ScheduleDialog } from "./schedule-dialog";
import type { EditorIntent } from "./use-authoring-editor";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "document";

/** The fields in form order (the focus goes to the first refused one). */
const FIELD_ORDER = [
  "title",
  "description",
  "category",
  "file",
  "departments",
  "publishAt",
  "unpublishAt",
] as const;

const ACTIONS: ItemActions = {
  save: saveDocument,
  publish: publishDocument,
  unpublish: unpublishDocument,
  discard: discardDocument,
  remove: deleteDocument,
};

/**
 * The document form (deep-dive decision 06 §A, §E, §L4, §L6, §N2): title,
 * description, category, the file and the departments that see it, with
 * the publish bar and, for moderators, Schedule… (publish and withdraw).
 *
 * The file (§L6): a picked file is checked at once (type by its name, the
 * size per type: 20 MB for PDF and Office, 5 MB for images) and uploaded
 * when the author saves, BEFORE the save, which then sends the new file's
 * id; "Replace the file" is the same on a document that has one. The
 * uploaded file stays in the form until a save takes it, so a conflict's
 * Overwrite, or a second try after another field was refused, never
 * uploads it again. Refusals of the upload (`fileType`, `fileTooLarge`)
 * show under the file input, which takes the focus.
 *
 * A department author (`access.roleClass` departmentAuthor) writes for
 * their own department: it is shown read-only and sent pinned; no
 * Schedule… and no Delete; Discard changes only while a published version
 * exists (the publish bar's rule, §N2).
 */
export function DocumentEditor({
  editable,
  access,
  timeZone,
  departments,
  optionsFailed,
  optionsTruncated,
  ownDepartment,
}: {
  editable: DocumentEditable | null;
  access: AreaAccess;
  timeZone: string;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
  /** A department author's department (pinned), else null. */
  ownDepartment: { documentId: string; name: string } | null;
}) {
  const t = useTranslations("manage.documents");
  const tc = useTranslations("manage.common");
  const tCategories = useTranslations("documents");
  const departmentAuthor = access.roleClass === "departmentAuthor";
  const [picked, setPicked] = useState<File | null>(null);
  const [pickError, setPickError] = useState<UploadFileCode | null>(null);
  const [uploading, startUpload] = useTransition();
  const [uploadIntent, setUploadIntent] = useState<EditorIntent | null>(null);
  // Reload and Discard reset the form to a fresh `editable`: a pick belongs
  // to the old one. A refresh after a save or a status change (unpublish,
  // publish) keeps it, like every other unsaved edit (Codex review).
  const dropPick = useCallback(() => {
    setPicked(null);
    setPickError(null);
  }, []);

  const item = useItemEditor<DocumentValues, DocumentEditable>({
    area: "documents",
    formId: FORM_ID,
    editable,
    toValues: documentValuesFromEditable,
    emptyValues: emptyDocumentValues(ownDepartment ? [ownDepartment.documentId] : []),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
    extraDirty: picked !== null,
    busy: uploading,
    onReset: dropPick,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("documents", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  // editor.pending covers the upload too (`busy`), so the focus after a
  // refused upload waits until the file input is enabled again.
  const pending = editor.pending;
  const targetingLocked = pending || optionsFailed;

  const fileError =
    error(UPLOAD_FILE_KEY) ?? (pickError ? t(`fields.file.${pickError}`) : undefined);
  const uploadedForSave = (values.file?.id ?? null) !== (item.initial.file?.id ?? null);

  const pick = (file: File) => {
    const code = checkUploadFile(file);
    setPickError(code);
    setPicked(code ? null : file);
  };

  /**
   * Runs `save` after the picked file's upload, with the uploaded file in
   * its values; without a pick, at once. The upload is its own request
   * (lib/manage/upload.ts); its refusals show like a save's.
   */
  const withUpload = (intent: EditorIntent, save: (override?: Partial<DocumentValues>) => void) => {
    if (!picked) {
      save();
      return;
    }
    const file = picked;
    // A refusal from the Schedule… dialog closes it first: the file input
    // and the alert are behind it, and the focus goes there, not back to
    // Schedule… (Codex review).
    const leaveDialog = () => {
      if (intent === "schedule") item.leaveSchedule();
    };
    const early = checkUploadFile(file);
    if (early) {
      leaveDialog();
      editor.refuse({ [UPLOAD_FILE_KEY]: early });
      return;
    }
    const form = new FormData();
    form.append(UPLOAD_FILE_KEY, file);
    setPickError(null);
    setUploadIntent(intent);
    startCmsAction(startUpload, {
      action: () => uploadDocumentFile(form),
      onSuccess: (uploaded) => {
        if (!uploaded) {
          leaveDialog();
          editor.fail("failed");
          return;
        }
        setPicked(null);
        setValue("file", uploaded);
        save({ file: uploaded });
      },
      onFailure: (code, failure) => {
        leaveDialog();
        if (code === "invalid" && failure.fields) {
          const sorted = sortFieldErrors(failure.fields, new Set(FIELD_ORDER));
          if (Object.keys(sorted.fields).length > 0) editor.refuse(sorted.fields);
          else editor.fail(sorted.unshown ? "unshown" : "invalid");
          return;
        }
        editor.fail(code);
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

  const categoryOptions = DOCUMENT_CATEGORIES.map((category) => ({
    value: category,
    label: tCategories(category),
  }));

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
        <EditorStatus
          meta={editor.meta}
          dirty={item.dirty}
          needsRetarget={editable?.needsRetarget}
          ownerDepartment={editable?.ownerDepartment}
          showOwner={!departmentAuthor}
        />

        <Section title={t("sections.document")}>
          <Field id={id("title")} label={t("fields.title.label")} error={error("title")} required>
            {(a11y) => (
              <input
                {...a11y}
                value={values.title}
                disabled={pending}
                onChange={(event) => setValue("title", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field
            id={id("description")}
            label={t("fields.description.label")}
            hint={t("fields.description.hint")}
            error={error("description")}
          >
            {(a11y) => (
              <textarea
                {...a11y}
                rows={4}
                value={values.description}
                disabled={pending}
                onChange={(event) => setValue("description", event.target.value)}
                className={cn(textareaClass, "min-h-24 font-sans")}
              />
            )}
          </Field>
          <SinglePicker
            id={id("category")}
            label={t("fields.category.label")}
            error={error("category")}
            value={values.category}
            options={categoryOptions}
            disabled={pending}
            onChange={(category) => setValue("category", category)}
          />
        </Section>

        <Section title={t("sections.file")}>
          <FileField
            id={id(UPLOAD_FILE_KEY)}
            label={t("fields.file.label")}
            hint={t("fields.file.hint")}
            error={fileError}
            current={values.file}
            uploadedForSave={uploadedForSave}
            picked={picked}
            disabled={pending}
            uploading={uploading}
            onPick={pick}
            onCancelPick={dropPick}
          />
        </Section>

        <Section title={t("sections.audience")}>
          {editable?.needsRetarget && (
            <RetargetNotice
              checked={item.retarget}
              disabled={targetingLocked}
              onChange={item.setRetarget}
            />
          )}
          {departmentAuthor ? (
            <PinnedDepartment name={ownDepartment?.name ?? ""} />
          ) : (
            <>
              <OptionsNotice failed={optionsFailed} truncated={optionsTruncated} />
              <CheckboxList
                id={id("departments")}
                legend={t("fields.departments.label")}
                hint={t("fields.departments.hint")}
                error={error("departments")}
                options={departments.map((d) => ({ value: d.documentId, label: d.name }))}
                selected={values.departments}
                disabled={targetingLocked}
                emptyText={tc("targeting.noneAvailable")}
                onChange={(selected) => setValue("departments", selected)}
              />
            </>
          )}
        </Section>

        <FormAlert area="documents" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="documents"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={pending}
          blocked={editor.meta === null && !departmentAuthor && optionsFailed}
          running={uploading ? uploadIntent : editor.running}
          handlers={handlers}
          onInvoke={editor.rememberInvoker}
        >
          <BackToList area="documents" />
        </PublishBar>
      </form>

      {access.verbs.includes("schedule") && (
        <ScheduleDialog
          area="documents"
          formId={FORM_ID}
          open={item.scheduleOpen}
          initial={scheduleValuesFromEditable(editor.meta ?? {}, timeZone)}
          hasSchedule={!!editor.meta?.publishAt || !!editor.meta?.unpublishAt}
          timeZone={timeZone}
          pending={pending}
          errorText={(field) => error(field)}
          onOpenChange={item.setScheduleOpen}
          returnFocus={item.scheduleOpener}
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
