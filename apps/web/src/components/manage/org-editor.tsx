"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  ORG_PATHS,
  UPLOAD_FILE_KEY,
  type DepartmentEditable,
  type OrgAuthoringType,
  type TeamEditable,
  type UploadFileCode,
} from "@sinnlos/domain";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { startCmsAction } from "@/lib/action-result";
import type { OrgEditable } from "@/lib/api/manage/org";
import type { OrgOptionsView } from "@/lib/loaders/manage/org";
import { fieldInputId, knownCode } from "@/lib/manage/errors";
import { createOrg, deleteOrg, saveOrg } from "@/lib/manage/org-actions";
import { emptyOrgValues, orgValuesFromEditable, type OrgValues } from "@/lib/manage/org-values";
import { uploadImageFile } from "@/lib/manage/upload";
import { checkUploadFile } from "@/lib/manage/upload-check";
import { ActionBar, ConflictDialog, FormAlert, useFieldError } from "./editor-chrome";
import { FileField } from "./file-field";
import { showFlash } from "./flash";
import { Field, FieldGroup, inputClass } from "./form-controls";
import { MarkdownEditor } from "./markdown-editor";
import { SinglePicker } from "./pickers";
import { metaOf, useAuthoringEditor } from "./use-authoring-editor";
import { useUnsavedGuard } from "./unsaved-guard";
import { sameValues } from "./use-item-editor";

const DEPARTMENT_FIELDS = ["name", "description", "color", "headerImage", "head"];
const TEAM_FIELDS = ["name", "department", "description", "avatar", "lead", "members"];
/** Where a new or deleted department/team leaves the admin: the reader list. */
const LIST_PATH = { department: "/departments", team: "/teams" } as const;

/**
 * One department or team. Heads and leads edit text (and a head the
 * color); admin_role also the structure (v0.22): name, head, a team's
 * department, lead and members, the image, create (`editable` null) and
 * delete. The CMS decides every field again.
 */
export function OrgEditor({
  type,
  editable,
  options,
}: {
  type: OrgAuthoringType;
  /** null: a new department or team (admin_role). */
  editable: OrgEditable | null;
  /** The structure pickers' lists (admin_role only). */
  options?: OrgOptionsView;
}) {
  const t = useTranslations("manage.org");
  const tc = useTranslations("manage.common");
  const router = useRouter();
  const creating = editable === null;
  const [values, setValues] = useState(() =>
    editable ? orgValuesFromEditable(editable) : emptyOrgValues(type),
  );
  const [initial, setInitial] = useState(values);
  const [picked, setPicked] = useState<File | null>(null);
  const [pickError, setPickError] = useState<UploadFileCode | null>(null);
  const [uploading, startUpload] = useTransition();
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const imageKey = type === "department" ? "headerImage" : "avatar";
  const admin = creating || editable.roleClass === "moderator";
  const formId = `org-${type}`;
  const dirty = picked !== null || !sameValues(values, initial);
  const onReset = useCallback(
    (source: OrgEditable | null) => {
      const fresh = source ? orgValuesFromEditable(source) : emptyOrgValues(type);
      setValues(fresh);
      setInitial(fresh);
      setPicked(null);
      setPickError(null);
      setSaved(false);
    },
    [type],
  );
  const editor = useAuthoringEditor({
    formId,
    initialMeta: editable ? metaOf(editable) : null,
    fieldOrder: type === "department" ? DEPARTMENT_FIELDS : TEAM_FIELDS,
    source: editable,
    onReset,
    externalBusy: uploading,
  });
  const error = useFieldError("org", editor.fieldErrors);
  const id = (field: string) => fieldInputId(formId, field);
  const setValue = <K extends keyof OrgValues>(key: K, value: OrgValues[K]) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  };
  const releaseUnsaved = useUnsavedGuard(dirty);

  // Names of everyone the form can show: the directory plus the stored
  // head, lead and members (a blocked member is not in the directory).
  const people = useMemo(() => {
    const names = new Map((options?.people ?? []).map((person) => [person.id, person.label]));
    const stored = editable as (Partial<DepartmentEditable> & Partial<TeamEditable>) | null;
    for (const person of [stored?.head, stored?.lead, ...(stored?.members ?? [])])
      if (person && !names.has(person.id)) names.set(person.id, person.displayName);
    return names;
  }, [options, editable]);
  const nameOf = (userId: number) => people.get(userId) ?? `#${userId}`;
  const personOptions = (selected: number | null) => [
    { value: "", label: t("fields.none") },
    ...(options?.people ?? []).map((person) => ({ value: String(person.id), label: person.label })),
    ...(selected !== null && !options?.people.some((person) => person.id === selected)
      ? [{ value: String(selected), label: nameOf(selected) }]
      : []),
  ];
  const pickersOff = editor.pending || options === undefined || options.failed;
  const deleteConflict = editor.conflict?.intent === "delete";

  const save = (snapshot = values) => {
    if (creating) {
      editor.run("create", () => createOrg(type, snapshot), {
        onSuccess: () => {
          setInitial(snapshot);
          showFlash(t(type === "department" ? "createdDepartment" : "createdTeam"));
          releaseUnsaved();
          router.push(LIST_PATH[type]);
        },
      });
      return;
    }
    editor.run(
      "save",
      (version) =>
        saveOrg(type, {
          documentId: editable.documentId,
          version,
          values: snapshot,
          initial,
        }),
      {
        onSuccess: () => {
          setInitial(snapshot);
          setSaved(true);
        },
      },
    );
  };
  const remove = () => {
    if (!editable) return;
    setConfirmDelete(false);
    editor.run("delete", (version) => deleteOrg(type, editable.documentId, version), {
      onSuccess: () => {
        // Clean also while the list is on its way: a picked image goes too.
        setInitial(values);
        setPicked(null);
        setPickError(null);
        showFlash(tc("success.deleted"));
        releaseUnsaved();
        router.push(LIST_PATH[type]);
      },
    });
  };
  const submit = () => {
    if ((!dirty && !creating) || editor.pending) return;
    if (!picked) {
      save();
      return;
    }
    const code = checkUploadFile(picked, true);
    if (code) {
      editor.refuse({ [imageKey]: code });
      return;
    }
    const form = new FormData();
    form.append(UPLOAD_FILE_KEY, picked);
    setPickError(null);
    startCmsAction(startUpload, {
      action: () => uploadImageFile(form),
      onSuccess: (uploaded) => {
        if (!uploaded) {
          editor.fail("failed");
          return;
        }
        setPicked(null);
        setValue("image", uploaded);
        save({ ...values, image: uploaded });
      },
      onFailure: (code, failure) => {
        if (code === "invalid" && failure.fields?.file) {
          editor.refuse({ [imageKey]: knownCode(failure.fields.file) });
        } else editor.fail(code);
      },
    });
  };
  const deleteBody =
    editable && "memberCount" in editable
      ? t("confirmDelete.departmentBody", {
          members: editable.memberCount ?? 0,
          teams: editable.teamCount ?? 0,
        })
      : t("confirmDelete.teamBody", {
          members: (editable as TeamEditable | null)?.members?.length ?? 0,
        });

  return (
    <>
      <form
        id={formId}
        noValidate
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-muted-foreground">
          {admin ? t("adminScopeHint") : t("scopeHint")}
        </p>
        {dirty && !creating && (
          <p className="text-sm text-amber-700 dark:text-amber-300">{tc("status.unsaved")}</p>
        )}
        {admin && (
          <Field
            id={id("name")}
            label={t("fields.name.label")}
            hint={type === "department" && !creating ? t("fields.name.entraHint") : undefined}
            error={error("name")}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="text"
                className={inputClass}
                value={values.name}
                maxLength={255}
                disabled={editor.pending}
                onChange={(event) => setValue("name", event.target.value)}
              />
            )}
          </Field>
        )}
        {admin && options?.failed && (
          <p className="text-sm text-destructive">{t("optionsFailed")}</p>
        )}
        {admin && type === "team" && (
          <SinglePicker
            id={id("department")}
            label={t("fields.department.label")}
            error={error("department")}
            value={values.department}
            placeholder={t("fields.department.placeholder")}
            options={[
              ...(creating ? [] : [{ value: "", label: t("fields.none") }]),
              ...(options?.departments ?? []).map((department) => ({
                value: department.documentId,
                label: department.name,
              })),
            ]}
            disabled={pickersOff}
            onChange={(value) => setValue("department", value)}
          />
        )}
        <MarkdownEditor
          id={id("description")}
          label={t("fields.description.label")}
          hint={t("fields.description.hint")}
          value={values.description}
          onChange={(value) => setValue("description", value)}
          disabled={editor.pending}
          error={error("description")}
        />
        {type === "department" && (
          <Field id={id("color")} label={t("fields.color.label")} error={error("color")}>
            {(a11y) => (
              <input
                {...a11y}
                type="color"
                className={inputClass}
                value={/^#[0-9a-f]{6}$/i.test(values.color) ? values.color : "#6366f1"}
                disabled={editor.pending}
                onChange={(event) => setValue("color", event.target.value)}
              />
            )}
          </Field>
        )}
        {admin && (
          <FileField
            id={id(imageKey)}
            label={t(`fields.${imageKey}.label`)}
            hint={t("imageHint")}
            imageOnly
            current={values.image}
            uploadedForSave={(values.image?.id ?? null) !== (initial.image?.id ?? null)}
            picked={picked}
            disabled={editor.pending}
            uploading={uploading}
            error={error(imageKey) ?? (pickError ? tc(`errors.${pickError}`) : undefined)}
            onPick={(file) => {
              const code = checkUploadFile(file, true);
              setPickError(code);
              setPicked(code ? null : file);
              setSaved(false);
            }}
            onCancelPick={() => {
              setPicked(null);
              setPickError(null);
            }}
            onRemove={() => {
              setValue("image", null);
              setPicked(null);
              setPickError(null);
            }}
          />
        )}
        {admin && type === "department" && (
          <SinglePicker
            id={id("head")}
            label={t("fields.head.label")}
            hint={t("fields.head.hint")}
            error={error("head")}
            value={values.head === null ? "" : String(values.head)}
            options={personOptions(values.head)}
            disabled={pickersOff}
            onChange={(value) => setValue("head", value === "" ? null : Number(value))}
          />
        )}
        {admin && type === "team" && (
          <>
            <SinglePicker
              id={id("lead")}
              label={t("fields.lead.label")}
              hint={t("fields.lead.hint")}
              error={error("lead")}
              value={values.lead === null ? "" : String(values.lead)}
              options={personOptions(values.lead)}
              disabled={pickersOff}
              onChange={(value) => setValue("lead", value === "" ? null : Number(value))}
            />
            {/* The field's id names a container: a refused save focuses its first control. */}
            <div id={id("members")}>
              <FieldGroup
                id={id("members")}
                legend={t("fields.members.label", { count: values.members.length })}
                hint={t("fields.members.hint")}
                error={error("members")}
              >
                {values.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("fields.members.empty")}</p>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {values.members
                      .map((userId) => ({ userId, name: nameOf(userId) }))
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(({ userId, name }) => (
                        <li
                          key={userId}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <span className="min-w-0 wrap-break-word text-sm">{name}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={editor.pending}
                            aria-label={t("fields.members.remove", { name })}
                            onClick={() =>
                              setValue(
                                "members",
                                values.members.filter((member) => member !== userId),
                              )
                            }
                          >
                            {t("fields.members.removeShort")}
                          </Button>
                        </li>
                      ))}
                  </ul>
                )}
                <SinglePicker
                  id={`${id("members")}-add`}
                  label={t("fields.members.add")}
                  value=""
                  placeholder={t("fields.members.addPlaceholder")}
                  options={(options?.people ?? [])
                    .filter((person) => !values.members.includes(person.id))
                    .map((person) => ({ value: String(person.id), label: person.label }))}
                  disabled={pickersOff}
                  onChange={(value) => {
                    if (value) setValue("members", [...values.members, Number(value)]);
                  }}
                />
              </FieldGroup>
            </div>
          </>
        )}
        <FormAlert area="org" failure={editor.failure} alertRef={editor.alertRef} />
        {deleteConflict && (
          // A delete is never repeated over a newer version: reload, read the counts again, confirm again.
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1">{t("deleteConflict")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                editor.clearConflict();
                editor.requestReset();
              }}
            >
              {tc("conflict.reload")}
            </Button>
          </div>
        )}
        <p role="status" className="text-sm text-muted-foreground">
          {saved && !dirty ? tc("success.saved") : ""}
        </p>
        <ActionBar label={tc("actions.toolbar")}>
          <Button type="submit" disabled={editor.pending || (!dirty && !creating)}>
            {editor.running === "save" || editor.running === "create"
              ? tc("actions.working")
              : creating
                ? tc("actions.create")
                : tc("actions.save")}
          </Button>
          <Link
            href={(creating ? LIST_PATH[type] : `/${ORG_PATHS[type]}/${editable.slug}`) as Route}
            className={buttonVariants({ variant: "ghost" })}
          >
            {creating ? tc("actions.backToList") : t("back")}
          </Link>
          {admin && !creating && (
            <>
              <span className="flex-1" aria-hidden="true" />
              <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                trigger={
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={editor.pending}
                    onClick={(event) => editor.rememberInvoker(event.currentTarget)}
                  >
                    {editor.running === "delete" ? tc("actions.working") : tc("actions.delete")}
                  </Button>
                }
                title={t(
                  type === "department"
                    ? "confirmDelete.departmentTitle"
                    : "confirmDelete.teamTitle",
                  { name: editable.name },
                )}
                description={deleteBody}
                confirmLabel={tc("confirm.deleteConfirm")}
                pending={editor.pending}
                onConfirm={remove}
              />
            </>
          )}
        </ActionBar>
      </form>
      <ConflictDialog
        conflict={deleteConflict ? null : editor.conflict}
        copyText={values.description}
        pending={editor.pending}
        onReload={() => {
          editor.clearConflict();
          editor.requestReset();
        }}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
