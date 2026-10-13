"use client";

import { useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { ICON_KEYS, QUICK_LINK_CATEGORIES, type QuickLinkEditable } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import { fieldInputId } from "@/lib/manage/errors";
import {
  deleteQuickLink,
  discardQuickLink,
  publishQuickLink,
  saveQuickLink,
  unpublishQuickLink,
} from "@/lib/manage/quick-link-actions";
import {
  emptyQuickLinkValues,
  quickLinkValuesFromEditable,
  scheduleValuesFromEditable,
  type QuickLinkValues,
} from "@/lib/manage/values";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import { CheckboxList, Field, inputClass } from "./form-controls";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { BackToList, OptionsNotice, RetargetNotice, Section } from "./editor-parts";
import { SinglePicker } from "./pickers";
import { PublishBar } from "./publish-bar";
import { ScheduleDialog } from "./schedule-dialog";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "quick-link";

const FIELD_ORDER = [
  "label",
  "url",
  "icon",
  "category",
  "order",
  "departments",
  "publishAt",
  "unpublishAt",
] as const;

const ACTIONS: ItemActions = {
  save: saveQuickLink,
  publish: publishQuickLink,
  unpublish: unpublishQuickLink,
  discard: discardQuickLink,
  remove: deleteQuickLink,
};

/**
 * The quick-link form (deep-dive decision 06 §A, §L4; moderators only):
 * label, address (an http(s) URL or an internal path), an icon from the
 * shared ICON_KEYS (K7: the names the dashboard can render), the category,
 * the order and the departments it is shown to. Schedule… sets both ends:
 * when it appears and when it is withdrawn.
 */
export function QuickLinkEditor({
  editable,
  access,
  timeZone,
  departments,
  optionsFailed,
  optionsTruncated,
}: {
  editable: QuickLinkEditable | null;
  access: AreaAccess;
  timeZone: string;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
}) {
  const t = useTranslations("manage.quickLinks");
  const tc = useTranslations("manage.common");
  const tCategories = useTranslations("quickLinks.categories");
  const toValues = useCallback(
    (source: QuickLinkEditable) => quickLinkValuesFromEditable(source),
    [],
  );
  const item = useItemEditor<QuickLinkValues, QuickLinkEditable>({
    area: "quickLinks",
    formId: FORM_ID,
    editable,
    toValues,
    emptyValues: emptyQuickLinkValues(),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("quickLinks", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;

  const iconOptions = useMemo(
    () => [
      { value: "", label: t("fields.icon.none") },
      ...ICON_KEYS.map((key) => ({ value: key, label: key })),
      // A name the shared list does not know (set in the admin panel) stays visible.
      ...(values.icon && !(ICON_KEYS as readonly string[]).includes(values.icon)
        ? [{ value: values.icon, label: values.icon }]
        : []),
    ],
    [t, values.icon],
  );
  const categoryOptions = QUICK_LINK_CATEGORIES.map((category) => ({
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
          item.handlers.saveDraft();
        }}
      >
        <EditorStatus
          meta={editor.meta}
          dirty={item.dirty}
          needsRetarget={editable?.needsRetarget}
          showOwner={false}
        />

        <Section title={t("sections.link")}>
          <Field id={id("label")} label={t("fields.label.label")} error={error("label")} required>
            {(a11y) => (
              <input
                {...a11y}
                value={values.label}
                disabled={disabled}
                onChange={(event) => setValue("label", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field
            id={id("url")}
            label={t("fields.url.label")}
            hint={t("fields.url.hint")}
            error={error("url")}
            required
          >
            {(a11y) => (
              <input
                {...a11y}
                inputMode="url"
                autoComplete="off"
                value={values.url}
                disabled={disabled}
                onChange={(event) => setValue("url", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <SinglePicker
              id={id("icon")}
              label={t("fields.icon.label")}
              error={error("icon")}
              value={values.icon}
              options={iconOptions}
              disabled={disabled}
              onChange={(icon) => setValue("icon", icon)}
            />
            <SinglePicker
              id={id("category")}
              label={t("fields.category.label")}
              error={error("category")}
              value={values.category}
              options={categoryOptions}
              disabled={disabled}
              onChange={(category) => setValue("category", category)}
            />
          </div>
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
                inputMode="numeric"
                min={0}
                max={10000}
                step={1}
                value={values.order}
                disabled={disabled}
                onChange={(event) => setValue("order", event.target.value)}
                className={`${inputClass} sm:max-w-40`}
              />
            )}
          </Field>
        </Section>

        <Section title={t("sections.audience")}>
          {editable?.needsRetarget && (
            <RetargetNotice
              checked={item.retarget}
              disabled={disabled || optionsFailed}
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
            disabled={disabled || optionsFailed}
            emptyText={tc("targeting.noneAvailable")}
            onChange={(selected) => setValue("departments", selected)}
          />
        </Section>

        <FormAlert area="quickLinks" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="quickLinks"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={editor.pending}
          blocked={editor.meta === null && optionsFailed}
          running={editor.running}
          handlers={item.handlers}
          onInvoke={editor.rememberInvoker}
        >
          <BackToList area="quickLinks" />
        </PublishBar>
      </form>

      {access.verbs.includes("schedule") && (
        <ScheduleDialog
          area="quickLinks"
          formId={FORM_ID}
          open={item.scheduleOpen}
          initial={scheduleValuesFromEditable(editor.meta ?? {}, timeZone)}
          hasSchedule={!!editor.meta?.publishAt || !!editor.meta?.unpublishAt}
          timeZone={timeZone}
          pending={editor.pending}
          errorText={(field) => error(field)}
          onOpenChange={item.setScheduleOpen}
          returnFocus={item.scheduleOpener}
          onSave={(schedule) => item.save("draft", schedule)}
        />
      )}
      <ConflictDialog
        conflict={editor.conflict}
        copyText={[values.label, values.url].filter(Boolean).join("\n")}
        pending={editor.pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
