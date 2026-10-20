"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Plus, Trash2 } from "lucide-react";
import {
  copyDutyWeek,
  dutyShiftOverlaps,
  type DutyPlanEditable,
  type DutyShift,
  type DutyShiftTemplate,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import type { AreaAccess } from "@/lib/manage/access";
import {
  deleteDutyPlan,
  discardDutyPlan,
  publishDutyPlan,
  saveDutyPlan,
  unpublishDutyPlan,
} from "@/lib/manage/duty-plan-actions";
import { fieldInputId } from "@/lib/manage/errors";
import {
  dutyPlanValuesFromEditable,
  emptyDutyPlanValues,
  type DutyPlanValues,
} from "@/lib/manage/values";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import {
  addDaysToKey,
  daysBetweenKeys,
  instantEpochMs,
  isoWeekdayOfKey,
  zonedDateKey,
  zonedTimeOfDay,
  zonedWallTimeToInstant,
} from "@/lib/plain-date";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { BackToList, OptionsNotice, PinnedDepartment, Section } from "./editor-parts";
import { Field, FieldError, inputClass } from "./form-controls";
import { SinglePicker } from "./pickers";
import { PublishBar } from "./publish-bar";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "duty-plan";

/** The fields in form order (the focus goes to the first refused one). */
const FIELD_ORDER = ["name", "note", "department", "shiftTemplates", "shifts"] as const;

const ACTIONS: ItemActions = {
  save: saveDutyPlan,
  publish: publishDutyPlan,
  unpublish: unpublishDutyPlan,
  discard: discardDutyPlan,
  remove: deleteDutyPlan,
};

/** Someone a shift can name: the directory's people (lib/people-dto.ts KudosRecipient). */
export interface DutyPerson {
  id: number;
  displayName: string;
  jobTitle: string | null;
}

/** A shift as the form shows it: days and wall times in APP_TIME_ZONE. */
interface ShiftParts {
  startDay: string;
  start: string;
  endDay: string;
  end: string;
}

function partsOf(shift: DutyShift, timeZone: string): ShiftParts {
  const day = (instant: string) =>
    instantEpochMs(instant) === null ? "" : zonedDateKey(instant, timeZone);
  const time = (instant: string) =>
    instantEpochMs(instant) === null ? "" : zonedTimeOfDay(instant, timeZone);
  return {
    startDay: day(shift.startsAt),
    start: time(shift.startsAt),
    endDay: day(shift.endsAt),
    end: time(shift.endsAt),
  };
}

/** The instant of a day and a time; an incomplete input stays as typed, and the save refuses it. */
function instantOf(day: string, time: string, timeZone: string): string {
  try {
    return zonedWallTimeToInstant(day, time, timeZone).toISOString();
  } catch {
    return `${day}T${time}`;
  }
}

function shiftOf(userId: number, parts: ShiftParts, timeZone: string): DutyShift {
  return {
    userId,
    startsAt: instantOf(parts.startDay, parts.start, timeZone),
    endsAt: instantOf(parts.endDay, parts.end, timeZone),
  };
}

/** A template's times on `day`; an end at or before the start is the next day. */
function templateParts(template: DutyShiftTemplate, day: string): ShiftParts {
  return {
    startDay: day,
    start: template.start,
    endDay: template.end <= template.start ? addDaysToKey(day, 1) : day,
    end: template.end,
  };
}

/** The Monday of the week of `day`. */
const mondayOf = (day: string) => addDaysToKey(day, 1 - isoWeekdayOfKey(day));

/**
 * The duty-plan form (v0.18, "Zuständigkeiten"): the duty's name, a note
 * and its department (a department author's own, shown fixed); the shift
 * templates (fixed times that may vary, owner decision 2026-10-20); and the
 * shifts: a person, a template or own times, start and end. Copy week
 * repeats a week's shifts in the next one at the same wall times. Several
 * people on one duty at a time are allowed; the form names the overlaps.
 */
export function DutyPlanEditor({
  editable,
  access,
  timeZone,
  departments,
  optionsFailed,
  optionsTruncated,
  ownDepartment,
  people,
  peopleFailed,
}: {
  editable: DutyPlanEditable | null;
  access: AreaAccess;
  timeZone: string;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
  /** A department author's department: pinned and shown, never picked. */
  ownDepartment: { documentId: string; name: string } | null;
  people: DutyPerson[];
  peopleFailed: boolean;
}) {
  const t = useTranslations("manage.dutyPlans");
  const departmentAuthor = access.roleClass === "departmentAuthor";
  const item = useItemEditor<DutyPlanValues, DutyPlanEditable>({
    area: "dutyPlans",
    formId: FORM_ID,
    editable,
    toValues: dutyPlanValuesFromEditable,
    emptyValues: emptyDutyPlanValues(ownDepartment?.documentId ?? ""),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("dutyPlans", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;
  const today = zonedDateKey(new Date(), timeZone);
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const [copied, setCopied] = useState<number | null>(null);

  const nameOf = useMemo(() => {
    const names = new Map(people.map((person) => [person.id, person.displayName]));
    return (userId: number) => names.get(userId) ?? `#${userId}`;
  }, [people]);

  const personOptions = useMemo(() => {
    const known = new Set(people.map((person) => person.id));
    // A shift naming someone the directory no longer lists stays visible.
    const unknown = [...new Set(values.shifts.map((shift) => shift.userId))].filter(
      (userId) => userId > 0 && !known.has(userId),
    );
    return [
      ...people.map((person) => ({
        value: String(person.id),
        label: person.jobTitle ? `${person.displayName} (${person.jobTitle})` : person.displayName,
      })),
      ...unknown.map((userId) => ({ value: String(userId), label: `#${userId}` })),
    ];
  }, [people, values.shifts]);

  const overlaps = useMemo(() => dutyShiftOverlaps(values.shifts), [values.shifts]);

  const setTemplates = (templates: DutyShiftTemplate[]) => setValue("shiftTemplates", templates);
  const setShifts = (shifts: DutyShift[]) => {
    setCopied(null);
    setValue("shifts", shifts);
  };
  const updateShift = (index: number, shift: DutyShift) =>
    setShifts(values.shifts.map((current, i) => (i === index ? shift : current)));

  const addShift = () => {
    const last = values.shifts.at(-1);
    const day = last ? partsOf(last, timeZone).startDay || today : today;
    const template = values.shiftTemplates[0];
    const parts = template
      ? templateParts(template, day)
      : { startDay: day, start: "06:00", endDay: day, end: "14:00" };
    setShifts([...values.shifts, shiftOf(0, parts, timeZone)]);
  };

  const copyWeek = () => {
    const copies = copyDutyWeek(values.shifts, weekStart, timeZone);
    setValue("shifts", [...values.shifts, ...copies]);
    setCopied(copies.length);
    setWeekStart(addDaysToKey(weekStart, 7));
  };

  const departmentOptions = [
    { value: "", label: t("fields.department.companyWide") },
    ...departments.map((department) => ({ value: department.documentId, label: department.name })),
  ];

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
          ownerDepartment={editable?.ownerDepartment}
          showOwner={!departmentAuthor}
        />

        <Section title={t("sections.plan")}>
          <Field
            id={id("name")}
            label={t("fields.name.label")}
            hint={t("fields.name.hint")}
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
          <Field
            id={id("note")}
            label={t("fields.note.label")}
            hint={t("fields.note.hint")}
            error={error("note")}
          >
            {(a11y) => (
              <input
                {...a11y}
                value={values.note}
                disabled={disabled}
                onChange={(event) => setValue("note", event.target.value)}
                className={inputClass}
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

        <Section title={t("sections.templates")} description={t("fields.shiftTemplates.hint")}>
          <div id={id("shiftTemplates")} role="group" tabIndex={-1} className="space-y-3">
            {values.shiftTemplates.map((template, index) => (
              <div key={index} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto]">
                <Field
                  id={`${id("shiftTemplates")}-${index}-label`}
                  label={t("fields.shiftTemplates.templateLabel")}
                >
                  {(a11y) => (
                    <input
                      {...a11y}
                      value={template.label}
                      disabled={disabled}
                      onChange={(event) =>
                        setTemplates(
                          values.shiftTemplates.map((current, i) =>
                            i === index ? { ...current, label: event.target.value } : current,
                          ),
                        )
                      }
                      className={inputClass}
                    />
                  )}
                </Field>
                {(["start", "end"] as const).map((edge) => (
                  <Field
                    key={edge}
                    id={`${id("shiftTemplates")}-${index}-${edge}`}
                    label={t(`fields.shiftTemplates.${edge}`)}
                  >
                    {(a11y) => (
                      <input
                        {...a11y}
                        type="time"
                        value={template[edge]}
                        disabled={disabled}
                        onChange={(event) =>
                          setTemplates(
                            values.shiftTemplates.map((current, i) =>
                              i === index ? { ...current, [edge]: event.target.value } : current,
                            ),
                          )
                        }
                        className={inputClass}
                      />
                    )}
                  </Field>
                ))}
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    aria-label={`${t("fields.shiftTemplates.remove")}: ${template.label}`}
                    onClick={() =>
                      setTemplates(values.shiftTemplates.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
            <FieldError id={`${id("shiftTemplates")}-error`}>{error("shiftTemplates")}</FieldError>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                setTemplates([
                  ...values.shiftTemplates,
                  { label: "", start: "06:00", end: "14:00" },
                ])
              }
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("fields.shiftTemplates.add")}
            </Button>
          </div>
        </Section>

        <Section title={t("sections.shifts")} description={t("fields.shifts.hint")}>
          {peopleFailed && (
            <p role="alert" className="rounded-xl border border-destructive/40 p-3 text-sm">
              {t("fields.shifts.peopleFailed")}
            </p>
          )}
          <div id={id("shifts")} role="group" tabIndex={-1} className="space-y-4">
            {values.shifts.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("fields.shifts.empty")}</p>
            )}
            {values.shifts.map((shift, index) => {
              const parts = partsOf(shift, timeZone);
              const rowId = `${id("shifts")}-${index}`;
              const matching = values.shiftTemplates.find(
                (template) =>
                  template.start === parts.start &&
                  template.end === parts.end &&
                  parts.endDay === templateParts(template, parts.startDay).endDay,
              );
              const templateOptions = [
                { value: "", label: t("fields.shifts.custom") },
                ...values.shiftTemplates.map((template) => ({
                  value: template.label,
                  label: `${template.label} (${template.start}–${template.end})`,
                })),
              ];
              const setParts = (next: ShiftParts) =>
                updateShift(index, shiftOf(shift.userId, next, timeZone));
              return (
                <div key={index} className="space-y-3 rounded-xl border p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SinglePicker
                      id={`${rowId}-person`}
                      label={t("fields.shifts.person")}
                      value={shift.userId > 0 ? String(shift.userId) : ""}
                      placeholder={t("fields.shifts.choosePerson")}
                      options={personOptions}
                      disabled={disabled}
                      onChange={(userId) =>
                        updateShift(index, { ...shift, userId: Number(userId) })
                      }
                    />
                    <SinglePicker
                      id={`${rowId}-template`}
                      label={t("fields.shifts.template")}
                      value={matching?.label ?? ""}
                      options={templateOptions}
                      disabled={disabled || values.shiftTemplates.length === 0}
                      onChange={(label) => {
                        const template = values.shiftTemplates.find(
                          (entry) => entry.label === label,
                        );
                        if (template) setParts(templateParts(template, parts.startDay || today));
                      }}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_8rem_auto]">
                    <Field id={`${rowId}-startDay`} label={t("fields.shifts.day")}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          type="date"
                          value={parts.startDay}
                          disabled={disabled}
                          onChange={(event) => {
                            const day = event.target.value;
                            // Moving the start day moves the end with it (the shift keeps its length).
                            const shiftBy =
                              parts.startDay && parts.endDay && day
                                ? daysBetweenKeys(parts.startDay, day)
                                : 0;
                            setParts({
                              ...parts,
                              startDay: day,
                              endDay: parts.endDay ? addDaysToKey(parts.endDay, shiftBy) : day,
                            });
                          }}
                          className={inputClass}
                        />
                      )}
                    </Field>
                    <Field id={`${rowId}-start`} label={t("fields.shifts.start")}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          type="time"
                          value={parts.start}
                          disabled={disabled}
                          onChange={(event) => setParts({ ...parts, start: event.target.value })}
                          className={inputClass}
                        />
                      )}
                    </Field>
                    <Field id={`${rowId}-endDay`} label={t("fields.shifts.endDay")}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          type="date"
                          value={parts.endDay}
                          disabled={disabled}
                          onChange={(event) => setParts({ ...parts, endDay: event.target.value })}
                          className={inputClass}
                        />
                      )}
                    </Field>
                    <Field id={`${rowId}-end`} label={t("fields.shifts.end")}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          type="time"
                          value={parts.end}
                          disabled={disabled}
                          onChange={(event) => setParts({ ...parts, end: event.target.value })}
                          className={inputClass}
                        />
                      )}
                    </Field>
                    <div className="flex items-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={disabled}
                        aria-label={`${t("fields.shifts.remove")}: ${nameOf(shift.userId)}`}
                        onClick={() => setShifts(values.shifts.filter((_, i) => i !== index))}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            <FieldError id={`${id("shifts")}-error`}>{error("shifts")}</FieldError>
            <div role="status" className="space-y-1 text-sm">
              {overlaps.slice(0, 3).map(([first, second]) => (
                <p key={`${first}-${second}`} className="text-amber-700 dark:text-amber-400">
                  {t("fields.shifts.overlap", {
                    first: nameOf(values.shifts[first]!.userId),
                    second: nameOf(values.shifts[second]!.userId),
                  })}
                </p>
              ))}
              {copied !== null && <p>{t("fields.shifts.copied", { count: copied })}</p>}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={addShift}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("fields.shifts.add")}
              </Button>
              <Field
                id={`${id("shifts")}-week`}
                label={t("fields.shifts.weekStart")}
                hint={t("fields.shifts.copyWeekHint")}
                className="w-44"
              >
                {(a11y) => (
                  <input
                    {...a11y}
                    type="date"
                    value={weekStart}
                    disabled={disabled}
                    onChange={(event) => setWeekStart(event.target.value || mondayOf(today))}
                    className={inputClass}
                  />
                )}
              </Field>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || values.shifts.length === 0}
                onClick={copyWeek}
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                {t("fields.shifts.copyWeek")}
              </Button>
            </div>
          </div>
        </Section>

        <FormAlert area="dutyPlans" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="dutyPlans"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={editor.pending}
          blocked={editor.meta === null && optionsFailed && !departmentAuthor}
          running={editor.running}
          handlers={item.handlers}
          onInvoke={editor.rememberInvoker}
        >
          <BackToList area="dutyPlans" />
        </PublishBar>
      </form>

      <ConflictDialog
        conflict={editor.conflict}
        copyText={values.name}
        pending={editor.pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
