"use client";

import { useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { EventEditable } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import { fieldInputId } from "@/lib/manage/errors";
import {
  deleteEvent,
  discardEvent,
  publishEvent,
  saveEvent,
  unpublishEvent,
} from "@/lib/manage/event-actions";
import {
  emptyEventValues,
  eventValuesFromEditable,
  scheduleValuesFromEditable,
  type EventValues,
} from "@/lib/manage/values";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import { CheckboxField, CheckboxList, Field, inputClass } from "./form-controls";
import { DateTimeField, DayField } from "./date-fields";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import {
  BackToList,
  EventVisibilityNote,
  OptionsNotice,
  PinnedDepartment,
  RetargetNotice,
  Section,
} from "./editor-parts";
import { MarkdownEditor } from "./markdown-editor";
import { PublishBar } from "./publish-bar";
import { ScheduleDialog } from "./schedule-dialog";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "event";

const FIELD_ORDER = [
  "title",
  "description",
  "allDay",
  "start",
  "end",
  "location",
  "url",
  "rsvpEnabled",
  "capacity",
  "departments",
  "publishAt",
] as const;

const ACTIONS: ItemActions = {
  save: saveEvent,
  publish: publishEvent,
  unpublish: unpublishEvent,
  discard: discardEvent,
  remove: deleteEvent,
};

/** The typed capacity as a number, or null (empty or not a whole number). */
function typedCapacity(value: string): number | null {
  return /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * The event form (deep-dive decision 06 §A, §L4, §N2, §N4): title,
 * Markdown description, when (a date and a time each, or the days of an
 * all-day event), place and link, responses with an optional capacity,
 * and the departments to notify. Every event is visible calendar-wide
 * (S10.9), so the departments only steer the notification.
 *
 *  - All-day: the first and the last day (inclusive), sent as the local
 *    midnights of APP_TIME_ZONE; a timed end without a date ends on the
 *    start's day.
 *  - Lowering the capacity below the people who accepted warns ("nobody
 *    is removed", §L4); turning responses off keeps the answers.
 *  - A department author: no Schedule… and no Delete, their department
 *    pinned as the one to notify, and the note that the event shows in
 *    everyone's calendar but notifies their department (§N4).
 */
export function EventEditor({
  editable,
  access,
  timeZone,
  departments,
  optionsFailed,
  optionsTruncated,
  ownDepartment,
  yesCount,
}: {
  editable: EventEditable | null;
  access: AreaAccess;
  timeZone: string;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
  ownDepartment: { documentId: string; name: string } | null;
  /** People who accepted (published events), for the capacity warning; null: unknown. */
  yesCount: number | null;
}) {
  const t = useTranslations("manage.events");
  const tc = useTranslations("manage.common");
  const departmentAuthor = access.roleClass === "departmentAuthor";
  const toValues = useCallback(
    (source: EventEditable) => eventValuesFromEditable(source, timeZone),
    [timeZone],
  );
  const item = useItemEditor<EventValues, EventEditable>({
    area: "events",
    formId: FORM_ID,
    editable,
    toValues,
    emptyValues: emptyEventValues(ownDepartment ? [ownDepartment.documentId] : []),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("events", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;
  const capacity = typedCapacity(values.capacity);
  const capacityWarning =
    values.rsvpEnabled && yesCount !== null && capacity !== null && capacity < yesCount;

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
          ownerDepartment={editable?.ownerDepartment}
          showOwner={!departmentAuthor}
        />

        <Section title={t("sections.content")}>
          <Field id={id("title")} label={t("fields.title.label")} error={error("title")} required>
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
          <MarkdownEditor
            id={id("description")}
            label={t("fields.description.label")}
            hint={tc("markdown.hint")}
            error={error("description")}
            value={values.description}
            disabled={disabled}
            onChange={(description) => setValue("description", description)}
          />
          <Field id={id("location")} label={t("fields.location.label")} error={error("location")}>
            {(a11y) => (
              <input
                {...a11y}
                value={values.location}
                disabled={disabled}
                onChange={(event) => setValue("location", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field
            id={id("url")}
            label={t("fields.url.label")}
            hint={t("fields.url.hint")}
            error={error("url")}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="url"
                inputMode="url"
                value={values.url}
                disabled={disabled}
                onChange={(event) => setValue("url", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        </Section>

        <Section title={t("sections.when")}>
          <CheckboxField
            id={id("allDay")}
            label={t("fields.allDay.label")}
            error={error("allDay")}
            checked={values.allDay}
            disabled={disabled}
            onChange={(allDay) => setValue("allDay", allDay)}
          />
          {values.allDay ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <DayField
                id={id("start")}
                label={t("fields.start.allDayLabel")}
                error={error("start")}
                value={values.startDate}
                required
                disabled={disabled}
                onChange={(startDate) => setValue("startDate", startDate)}
              />
              <DayField
                id={id("end")}
                label={t("fields.end.allDayLabel")}
                hint={t("fields.end.allDayHint")}
                error={error("end")}
                value={values.endDate}
                min={values.startDate || undefined}
                disabled={disabled}
                onChange={(endDate) => setValue("endDate", endDate)}
              />
            </div>
          ) : (
            <>
              <DateTimeField
                id={id("start")}
                legend={t("fields.start.label")}
                error={error("start")}
                date={values.startDate}
                time={values.startTime}
                timeZone={timeZone}
                required
                disabled={disabled}
                onDateChange={(startDate) => setValue("startDate", startDate)}
                onTimeChange={(startTime) => setValue("startTime", startTime)}
              />
              <DateTimeField
                id={id("end")}
                legend={t("fields.end.label")}
                hint={t("fields.end.hint")}
                error={error("end")}
                date={values.endDate}
                time={values.endTime}
                timeZone={timeZone}
                disabled={disabled}
                onDateChange={(endDate) => setValue("endDate", endDate)}
                onTimeChange={(endTime) => setValue("endTime", endTime)}
              />
            </>
          )}
        </Section>

        <Section title={t("sections.rsvp")}>
          <CheckboxField
            id={id("rsvpEnabled")}
            label={t("fields.rsvpEnabled.label")}
            hint={t("fields.rsvpEnabled.hint")}
            error={error("rsvpEnabled")}
            checked={values.rsvpEnabled}
            disabled={disabled}
            onChange={(rsvpEnabled) => setValue("rsvpEnabled", rsvpEnabled)}
          />
          <Field
            id={id("capacity")}
            label={t("fields.capacity.label")}
            hint={t("fields.capacity.hint")}
            error={error("capacity")}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={values.capacity}
                disabled={disabled || !values.rsvpEnabled}
                onChange={(event) => setValue("capacity", event.target.value)}
                className={`${inputClass} sm:max-w-40`}
              />
            )}
          </Field>
          {capacityWarning && (
            <p
              role="status"
              className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t("capacityWarning", { count: yesCount })}
            </p>
          )}
        </Section>

        <Section title={t("sections.notify")}>
          {editable?.needsRetarget && (
            <RetargetNotice
              checked={item.retarget}
              disabled={disabled || (!departmentAuthor && optionsFailed)}
              onChange={item.setRetarget}
            />
          )}
          {departmentAuthor ? (
            <>
              <PinnedDepartment name={ownDepartment?.name ?? ""} />
              <EventVisibilityNote />
            </>
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
                disabled={disabled || optionsFailed}
                emptyText={tc("targeting.noneAvailable")}
                onChange={(selected) => setValue("departments", selected)}
              />
            </>
          )}
        </Section>

        <FormAlert area="events" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="events"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={editor.pending}
          blocked={editor.meta === null && optionsFailed}
          running={editor.running}
          handlers={item.handlers}
        >
          <BackToList area="events" />
        </PublishBar>
      </form>

      {access.verbs.includes("schedule") && (
        <ScheduleDialog
          area="events"
          formId={FORM_ID}
          open={item.scheduleOpen}
          initial={scheduleValuesFromEditable(editor.meta ?? {}, timeZone)}
          hasSchedule={!!editor.meta?.publishAt}
          timeZone={timeZone}
          pending={editor.pending}
          errorText={(field) => error(field)}
          onOpenChange={item.setScheduleOpen}
          onSave={(schedule) => item.save("draft", schedule)}
        />
      )}
      <ConflictDialog
        conflict={editor.conflict}
        copyText={[values.title, values.description].filter(Boolean).join("\n\n")}
        pending={editor.pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
      />
    </>
  );
}
