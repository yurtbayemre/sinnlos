"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { processDiagramCode, type ProcessEditable } from "@sinnlos/domain";
import { DiagramModelerLazy } from "@/components/processes/diagram-modeler-lazy";
import type { ModelerApi } from "@/components/processes/diagram-modeler";
import type { AreaAccess } from "@/lib/manage/access";
import { fieldInputId } from "@/lib/manage/errors";
import {
  deleteProcess,
  discardProcess,
  publishProcess,
  saveProcess,
  unpublishProcess,
} from "@/lib/manage/process-actions";
import {
  emptyProcessValues,
  processValuesFromEditable,
  type ProcessValues,
} from "@/lib/manage/values";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import { NEW_PROCESS_DIAGRAM, importFileTooLarge } from "@/lib/process-diagram";
import { cn } from "@/lib/utils";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { BackToList, OptionsNotice, PinnedDepartment, Section } from "./editor-parts";
import { Field, FieldError, inputClass, textareaClass } from "./form-controls";
import { SinglePicker } from "./pickers";
import { draftSubmit, PublishBar, type PublishBarHandlers } from "./publish-bar";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "process";

/** The fields in form order (the focus goes to the first refused one). */
const FIELD_ORDER = ["title", "summary", "department", "diagram"] as const;

const ACTIONS: ItemActions = {
  save: saveProcess,
  publish: publishProcess,
  unpublish: unpublishProcess,
  discard: discardProcess,
  remove: deleteProcess,
};

type ImportNote = {
  kind: "ok" | "error";
  key: "imported" | "importTooLarge" | "importInvalid" | "importFailed";
};

/**
 * The process form (v1.1 "Tools"): a title, the description in words (the diagram's
 * text alternative, so it is required), the department and the BPMN diagram, drawn in
 * the bpmn-js Modeler (loaded in the browser only) or imported from a .bpmn file.
 *
 * The diagram travels as part of the values: the modeler reports its XML after an edit
 * (and a save asks for the latest first), an untouched diagram is never rewritten, and
 * an import replaces it. Drawing needs a mouse or touch; the import, the description
 * and the save work by keyboard, and the form says so.
 */
export function ProcessEditor({
  editable,
  access,
  departments,
  optionsFailed,
  optionsTruncated,
  ownDepartment,
}: {
  editable: ProcessEditable | null;
  access: AreaAccess;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
  /** A department author's department: pinned and shown, never picked. */
  ownDepartment: { documentId: string; name: string } | null;
}) {
  const t = useTranslations("manage.processes");
  const departmentAuthor = access.roleClass === "departmentAuthor";
  // The modeler restarts on another diagram: a reset to the fresh `editable` (Reload,
  // Discard changes) bumps the key, and values and key change in one render.
  const [generation, setGeneration] = useState(0);
  // An edit the modeler has not reported yet still counts as an unsaved change.
  const [editing, setEditing] = useState(false);
  const item = useItemEditor<ProcessValues, ProcessEditable>({
    area: "processes",
    formId: FORM_ID,
    editable,
    toValues: processValuesFromEditable,
    emptyValues: emptyProcessValues(ownDepartment?.documentId ?? "", NEW_PROCESS_DIAGRAM),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
    extraDirty: editing,
    onReset: () => {
      setGeneration((n) => n + 1);
      setEditing(false);
    },
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("processes", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;

  // The modeler's save and load, once it has mounted (state, not a ref: handlers read it).
  const [modeler, setModeler] = useState<ModelerApi | null>(null);
  const [modelerFailed, setModelerFailed] = useState(false);
  const [note, setNote] = useState<ImportNote | null>(null);

  const onChange = useCallback(
    (xml: string) => {
      setValue("diagram", xml);
      setEditing(false);
    },
    [setValue],
  );

  /** The diagram the save sends: the modeler's latest, when the author edited it. */
  const withDiagram = useCallback(
    async (status: "draft" | "published") => {
      const xml = (await modeler?.save()) ?? null;
      setEditing(false);
      if (xml !== null && xml !== values.diagram) {
        setValue("diagram", xml);
        item.save(status, undefined, { diagram: xml });
      } else {
        item.save(status);
      }
    },
    [item, modeler, setValue, values.diagram],
  );

  const handlers: PublishBarHandlers = useMemo(
    () => ({
      ...item.handlers,
      saveDraft: () => void withDiagram("draft"),
      saveAndPublish: () => void withDiagram("published"),
    }),
    [item.handlers, withDiagram],
  );

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setNote(null);
    // The size is checked BEFORE the file is read into memory.
    if (importFileTooLarge(file)) return setNote({ kind: "error", key: "importTooLarge" });
    let text: string;
    try {
      text = await file.text();
    } catch {
      return setNote({ kind: "error", key: "importFailed" });
    }
    // The cms's own rules, before the modeler draws the file.
    const code = processDiagramCode(text);
    if (code !== null) {
      return setNote({
        kind: "error",
        key: code === "tooLong" ? "importTooLarge" : "importInvalid",
      });
    }
    try {
      // The modeler's own formatted XML is what is stored (saveXML, format: true).
      const xml = await modeler?.load(text);
      if (xml === undefined) return setNote({ kind: "error", key: "importFailed" });
      setValue("diagram", xml);
      setModelerFailed(false);
      setNote({ kind: "ok", key: "imported" });
    } catch {
      setNote({ kind: "error", key: "importInvalid" });
    }
  };

  const departmentOptions = [
    { value: "", label: t("fields.department.companyWide") },
    ...departments.map((department) => ({ value: department.documentId, label: department.name })),
  ];
  const diagramError = error("diagram");
  const diagramErrorId = `${id("diagram")}-error`;

  // Fail closed (decision 02): no save of a create whose pickers failed.
  const blocked = editor.meta === null && optionsFailed && !departmentAuthor;
  return (
    <>
      <form
        id={FORM_ID}
        noValidate
        className="space-y-8"
        onSubmit={draftSubmit(blocked, handlers.saveDraft)}
      >
        <EditorStatus
          meta={editor.meta}
          dirty={item.dirty}
          ownerDepartment={editable?.ownerDepartment}
          showOwner={!departmentAuthor}
        />

        <Section title={t("sections.process")}>
          <Field
            id={id("title")}
            label={t("fields.title.label")}
            hint={t("fields.title.hint")}
            error={error("title")}
            required
          >
            {(a11y) => (
              <input
                {...a11y}
                value={values.title}
                disabled={disabled}
                onChange={(event) => setValue("title", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field
            id={id("summary")}
            label={t("fields.summary.label")}
            hint={t("fields.summary.hint")}
            error={error("summary")}
            required
          >
            {(a11y) => (
              <textarea
                {...a11y}
                rows={5}
                value={values.summary}
                disabled={disabled}
                onChange={(event) => setValue("summary", event.target.value)}
                className={cn(textareaClass, "min-h-28 font-sans")}
              />
            )}
          </Field>
          {departmentAuthor ? (
            <PinnedDepartment name={ownDepartment?.name ?? ""} />
          ) : (
            <>
              <OptionsNotice failed={optionsFailed} truncated={optionsTruncated} />
              <SinglePicker
                id={id("department")}
                label={t("fields.department.label")}
                hint={t("fields.department.hint")}
                error={error("department")}
                value={values.department}
                options={departmentOptions}
                disabled={disabled || optionsFailed}
                onChange={(department) => setValue("department", department)}
              />
            </>
          )}
        </Section>

        <Section title={t("sections.diagram")} description={t("diagram.keyboardNote")}>
          <Field
            id={id("import")}
            label={t("diagram.import")}
            hint={`${t("diagram.importHint")} ${t("diagram.storedNote")}`}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="file"
                accept=".bpmn,.xml,application/xml,text/xml"
                disabled={disabled}
                onChange={(event) => {
                  const input = event.currentTarget;
                  void importFile(input.files?.[0]).finally(() => {
                    input.value = "";
                  });
                }}
                className="block w-full text-sm file:mr-3 file:h-9 file:rounded-xl file:border file:bg-background file:px-3 file:text-sm file:font-medium hover:file:bg-accent"
              />
            )}
          </Field>
          <p
            role="status"
            className={cn(
              "text-sm",
              note?.kind === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {note ? t(`diagram.${note.key}`) : null}
          </p>
          {modelerFailed ? (
            <p role="alert" className="text-sm text-destructive">
              {t("diagram.loadFailed")}
            </p>
          ) : null}
          <div
            id={id("diagram")}
            tabIndex={-1}
            aria-describedby={diagramError ? diagramErrorId : undefined}
            className="space-y-2 outline-hidden"
          >
            <DiagramModelerLazy
              key={`${editable?.documentId ?? "new"}-${generation}`}
              xml={values.diagram}
              label={t("diagram.canvasLabel")}
              onEdit={() => setEditing(true)}
              onChange={onChange}
              onApi={setModeler}
              onFailed={() => setModelerFailed(true)}
            />
            <FieldError id={diagramErrorId}>{diagramError}</FieldError>
          </div>
        </Section>

        <FormAlert area="processes" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="processes"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={editor.pending}
          blocked={blocked}
          running={editor.running}
          handlers={handlers}
          onInvoke={editor.rememberInvoker}
        >
          <BackToList area="processes" />
        </PublishBar>
      </form>

      <ConflictDialog
        conflict={editor.conflict}
        copyText={values.title}
        pending={editor.pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
