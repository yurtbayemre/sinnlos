"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ICON_KEYS,
  ROLE_PRIVILEGE_ORDER,
  WIKI_SPACE_VISIBILITIES,
  type WikiSpaceEditable,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AreaAccess } from "@/lib/manage/access";
import { fieldInputId } from "@/lib/manage/errors";
import { cn } from "@/lib/utils";
import type { DepartmentOption, TeamOption } from "@/lib/loaders/manage/options";
import { deleteWikiSpace, saveWikiSpace } from "@/lib/manage/wiki-space-actions";
import {
  emptyWikiSpaceValues,
  wikiSpaceValuesFromEditable,
  type WikiSpaceValues,
} from "@/lib/manage/wiki-values";
import { CheckboxList, Field, inputClass, textareaClass } from "./form-controls";
import { ActionBar, ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { BackToList, OptionsNotice, RetargetNotice, Section } from "./editor-parts";
import { SinglePicker } from "./pickers";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "wiki-space";

const FIELD_ORDER = [
  "name",
  "icon",
  "description",
  "visibility",
  "allowedRoles",
  "department",
  "team",
] as const;

const ACTIONS: ItemActions = { save: saveWikiSpace, remove: deleteWikiSpace };

/**
 * The wiki-space form of /manage/wiki (deep-dive decision 06 §J1, §B3, §L4;
 * batch 16 plan, lane 16C item 4; moderators only): name, icon (the shared
 * ICON_KEYS), description, and who reads it: everyone, certain roles, one
 * department or one team, each with its target. A space is always
 * published: Create and Save write it at once. Its address is made from the
 * name on create and stays.
 *
 * Delete asks first and works only on an empty space: the cms refuses a
 * space with pages (`spaceNotEmpty`), which the form explains. A space
 * whose department or team was deleted needs re-targeting (only moderators
 * read it): its picker says "Restricted", and making it public needs the
 * confirmation, like the other areas.
 */
export function WikiSpaceEditor({
  editable,
  access,
  departments,
  teams,
  optionsFailed,
  optionsTruncated,
}: {
  editable: WikiSpaceEditable | null;
  access: AreaAccess;
  departments: DepartmentOption[];
  teams: TeamOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
}) {
  const t = useTranslations("manage.wiki");
  const tc = useTranslations("manage.common");
  const item = useItemEditor<WikiSpaceValues, WikiSpaceEditable>({
    area: "wiki",
    formId: FORM_ID,
    editable,
    toValues: wikiSpaceValuesFromEditable,
    emptyValues: emptyWikiSpaceValues(),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
    drafts: false,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("wiki", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;
  const targetingLocked = disabled || optionsFailed;
  const creating = editor.meta === null;
  const can = (verb: "create" | "edit" | "delete") => access.verbs.includes(verb);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const restricted = editable?.needsRetarget === true;

  const iconOptions = useMemo(
    () => [
      { value: "", label: t("fields.icon.none") },
      ...ICON_KEYS.map((key) => ({ value: key, label: key })),
      // A value the shared list does not know (the admin panel's "book") stays visible.
      ...(values.icon && !(ICON_KEYS as readonly string[]).includes(values.icon)
        ? [{ value: values.icon, label: values.icon }]
        : []),
    ],
    [t, values.icon],
  );
  const visibilityOptions = WIKI_SPACE_VISIBILITIES.map((visibility) => ({
    value: visibility,
    label: t(`visibility.${visibility}`),
  }));
  const roleOptions = ROLE_PRIVILEGE_ORDER.map((role) => ({
    value: role,
    label: tc(`targeting.roles.${role}`),
  }));
  const departmentOptions = departments.map((d) => ({ value: d.documentId, label: d.name }));
  const teamOptions = teams.map((team) => ({ value: team.documentId, label: team.name }));
  // A target that is gone reads "Restricted", not an empty choice (§N9's pattern).
  const placeholder = (field: "department" | "team") =>
    restricted && !values[field] ? tc("targeting.restricted") : t(`fields.${field}.choose`);

  return (
    <>
      <form
        id={FORM_ID}
        noValidate
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          item.save("published");
        }}
      >
        <EditorStatus
          meta={editor.meta}
          dirty={item.dirty}
          needsRetarget={editable?.needsRetarget}
          showOwner={false}
          hideStatus
        />

        <Section title={t("sections.space")}>
          <Field
            id={id("name")}
            label={t("fields.name.label")}
            hint={editable ? t("list.address", { slug: editable.slug }) : t("fields.name.hint")}
            error={error("name")}
            required
          >
            {(a11y) => (
              <input
                {...a11y}
                value={values.name}
                disabled={disabled}
                onChange={(event) => setValue("name", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <SinglePicker
            id={id("icon")}
            label={t("fields.icon.label")}
            error={error("icon")}
            value={values.icon}
            options={iconOptions}
            disabled={disabled}
            onChange={(icon) => setValue("icon", icon)}
          />
          <Field
            id={id("description")}
            label={t("fields.description.label")}
            error={error("description")}
          >
            {(a11y) => (
              <textarea
                {...a11y}
                rows={3}
                value={values.description}
                disabled={disabled}
                onChange={(event) => setValue("description", event.target.value)}
                className={cn(textareaClass, "min-h-20 font-sans")}
              />
            )}
          </Field>
        </Section>

        <Section title={t("sections.readers")} description={t("fields.visibility.hint")}>
          {restricted && (
            <RetargetNotice
              checked={item.retarget}
              disabled={targetingLocked}
              onChange={item.setRetarget}
              kind="deleted"
            />
          )}
          <OptionsNotice failed={optionsFailed} truncated={optionsTruncated} />
          <SinglePicker
            id={id("visibility")}
            label={t("fields.visibility.label")}
            error={error("visibility")}
            value={values.visibility}
            options={visibilityOptions}
            disabled={targetingLocked}
            onChange={(visibility) => setValue("visibility", visibility)}
          />
          {values.visibility === "role" && (
            <CheckboxList
              id={id("allowedRoles")}
              legend={t("fields.allowedRoles.label")}
              error={error("allowedRoles")}
              options={roleOptions}
              selected={values.allowedRoles}
              disabled={targetingLocked}
              onChange={(allowedRoles) => setValue("allowedRoles", allowedRoles)}
            />
          )}
          {values.visibility === "department" && (
            <SinglePicker
              id={id("department")}
              label={t("fields.department.label")}
              error={error("department")}
              value={values.department}
              placeholder={placeholder("department")}
              options={departmentOptions}
              disabled={targetingLocked}
              onChange={(department) => setValue("department", department)}
            />
          )}
          {values.visibility === "team" && (
            <SinglePicker
              id={id("team")}
              label={t("fields.team.label")}
              error={error("team")}
              value={values.team}
              placeholder={placeholder("team")}
              options={teamOptions}
              disabled={targetingLocked}
              onChange={(team) => setValue("team", team)}
            />
          )}
        </Section>

        {!creating && editable && editable.pageCount > 0 && can("delete") && (
          <p className="text-sm text-muted-foreground">
            {t("space.deleteHasPages", { count: editable.pageCount })}
          </p>
        )}
        <FormAlert area="wiki" failure={editor.failure} alertRef={editor.alertRef} />
        <ActionBar label={tc("actions.toolbar")}>
          {(creating ? can("create") : can("edit")) && (
            // A create whose pickers could not load might only reach everyone
            // (decision 02: fail closed): it waits for a reload.
            <Button type="submit" disabled={disabled || (creating ? optionsFailed : !item.dirty)}>
              {editor.running === "create" || editor.running === "saveAndPublish"
                ? tc("actions.working")
                : creating
                  ? tc("actions.create")
                  : tc("actions.save")}
            </Button>
          )}
          <span className="flex-1" aria-hidden="true" />
          <BackToList area="wiki" />
          {!creating && can("delete") && (
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              trigger={
                <Button
                  type="button"
                  variant="destructive"
                  disabled={disabled}
                  onClick={(event) => editor.rememberInvoker(event.currentTarget)}
                >
                  {editor.running === "delete" ? tc("actions.working") : tc("actions.delete")}
                </Button>
              }
              title={tc("confirm.deleteTitle")}
              description={
                editable && editable.pageCount > 0
                  ? t("space.deleteHasPages", { count: editable.pageCount })
                  : t("space.deleteBody")
              }
              confirmLabel={tc("confirm.deleteConfirm")}
              pending={disabled}
              onConfirm={() => {
                setConfirmDelete(false);
                item.handlers.delete();
              }}
            />
          )}
        </ActionBar>
      </form>

      <ConflictDialog
        conflict={editor.conflict}
        copyText={[values.name, values.description].filter(Boolean).join("\n\n")}
        pending={editor.pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
