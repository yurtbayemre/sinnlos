"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  ORG_PATHS,
  UPLOAD_FILE_KEY,
  type OrgAuthoringType,
  type UploadFileCode,
} from "@sinnlos/domain";
import { Button, buttonVariants } from "@/components/ui/button";
import { startCmsAction } from "@/lib/action-result";
import type { OrgEditable } from "@/lib/api/manage/org";
import { fieldInputId, knownCode } from "@/lib/manage/errors";
import { saveOrg } from "@/lib/manage/org-actions";
import { orgValuesFromEditable, type OrgValues } from "@/lib/manage/org-values";
import { uploadImageFile } from "@/lib/manage/upload";
import { checkUploadFile } from "@/lib/manage/upload-check";
import { ActionBar, ConflictDialog, FormAlert, useFieldError } from "./editor-chrome";
import { Field, inputClass } from "./form-controls";
import { FileField } from "./file-field";
import { MarkdownEditor } from "./markdown-editor";
import { metaOf, useAuthoringEditor } from "./use-authoring-editor";
import { sameValues } from "./use-item-editor";

const DEPARTMENT_FIELDS = ["description", "color", "headerImage"];
const TEAM_FIELDS = ["description", "avatar"];

export function OrgEditor({ type, editable }: { type: OrgAuthoringType; editable: OrgEditable }) {
  const t = useTranslations("manage.org");
  const tc = useTranslations("manage.common");
  const [values, setValues] = useState(() => orgValuesFromEditable(editable));
  const [initial, setInitial] = useState(values);
  const [picked, setPicked] = useState<File | null>(null);
  const [pickError, setPickError] = useState<UploadFileCode | null>(null);
  const [uploading, startUpload] = useTransition();
  const [saved, setSaved] = useState(false);
  const imageKey = type === "department" ? "headerImage" : "avatar";
  const admin = editable.roleClass === "moderator";
  const formId = `org-${type}`;
  const dirty = picked !== null || !sameValues(values, initial);
  const onReset = useCallback((source: OrgEditable) => {
    const fresh = orgValuesFromEditable(source);
    setValues(fresh);
    setInitial(fresh);
    setPicked(null);
    setPickError(null);
    setSaved(false);
  }, []);
  const editor = useAuthoringEditor({
    formId,
    initialMeta: metaOf(editable),
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
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = (snapshot = values) => {
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
  const submit = () => {
    if (!dirty || editor.pending) return;
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
        <p className="text-sm text-muted-foreground">{t("scopeHint")}</p>
        {dirty && (
          <p className="text-sm text-amber-700 dark:text-amber-300">{tc("status.unsaved")}</p>
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
        <FormAlert area="org" failure={editor.failure} alertRef={editor.alertRef} />
        <p role="status" className="text-sm text-muted-foreground">
          {saved && !dirty ? tc("success.saved") : ""}
        </p>
        <ActionBar label={tc("actions.toolbar")}>
          <Button type="submit" disabled={editor.pending || !dirty}>
            {editor.pending ? tc("actions.working") : tc("actions.save")}
          </Button>
          <Link
            href={`/${ORG_PATHS[type]}/${editable.slug}` as Route}
            className={buttonVariants({ variant: "ghost" })}
          >
            {t("back")}
          </Link>
        </ActionBar>
      </form>
      <ConflictDialog
        conflict={editor.conflict}
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
