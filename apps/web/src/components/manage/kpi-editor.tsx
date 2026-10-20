"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { History } from "lucide-react";
import {
  KPI_AGGREGATIONS,
  KPI_PERIODS,
  KPI_WINDOW,
  recentKpiPeriods,
  type KpiAggregation,
  type KpiEditable,
  type KpiPeriod,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { kpiPeriodLabel } from "@/lib/kpi-format";
import type { AreaAccess } from "@/lib/manage/access";
import { deleteKpi, discardKpi, publishKpi, saveKpi, unpublishKpi } from "@/lib/manage/kpi-actions";
import { fieldInputId } from "@/lib/manage/errors";
import { emptyKpiValues, kpiValuesFromEditable, type KpiValues } from "@/lib/manage/values";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import { zonedDateKey } from "@/lib/plain-date";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { BackToList, OptionsNotice, PinnedDepartment, Section } from "./editor-parts";
import { Field, FieldError, inputClass } from "./form-controls";
import { SinglePicker } from "./pickers";
import { PublishBar } from "./publish-bar";
import { useItemEditor, type ItemActions } from "./use-item-editor";

const FORM_ID = "kpi";

/** The fields in form order (the focus goes to the first refused one). */
const FIELD_ORDER = [
  "name",
  "unit",
  "description",
  "department",
  "period",
  "aggregation",
  "values",
] as const;

const ACTIONS: ItemActions = {
  save: saveKpi,
  publish: publishKpi,
  unpublish: unpublishKpi,
  discard: discardKpi,
  remove: deleteKpi,
};

/**
 * The KPI form (v0.19): what is counted, in which unit and rhythm, and a
 * table of the latest periods to type the values into. The rhythm is
 * fixed once values exist (their keys are that rhythm's period starts).
 */
export function KpiEditor({
  editable,
  access,
  timeZone,
  departments,
  optionsFailed,
  optionsTruncated,
  ownDepartment,
}: {
  editable: KpiEditable | null;
  access: AreaAccess;
  timeZone: string;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
  /** A department author's department: pinned and shown, never picked. */
  ownDepartment: { documentId: string; name: string } | null;
}) {
  const t = useTranslations("manage.kpis");
  const locale = useLocale();
  const departmentAuthor = access.roleClass === "departmentAuthor";
  const item = useItemEditor<KpiValues, KpiEditable>({
    area: "kpis",
    formId: FORM_ID,
    editable,
    toValues: kpiValuesFromEditable,
    emptyValues: emptyKpiValues(ownDepartment?.documentId ?? ""),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("kpis", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;
  const [count, setCount] = useState(KPI_WINDOW);
  // The values' error describes the group and every entry (focus lands on either).
  const valuesError = error("values");
  const valuesErrorId = `${id("values")}-error`;

  const today = zonedDateKey(new Date(), timeZone);
  const periods = recentKpiPeriods(today, values.period, count);
  const shown = new Set(periods);
  const hasValues = Object.keys(values.values).length > 0;
  const hidden = Object.keys(values.values).filter((key) => !shown.has(key)).length;

  const setEntry = (period: string, text: string) => {
    const next = { ...values.values, [period]: text };
    if (text.trim() === "") delete next[period];
    // Sorted keys: the same values compare equal however they were typed in.
    setValue("values", Object.fromEntries(Object.entries(next).sort()));
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

        <Section title={t("sections.kpi")}>
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
            id={id("unit")}
            label={t("fields.unit.label")}
            hint={t("fields.unit.hint")}
            error={error("unit")}
          >
            {(a11y) => (
              <input
                {...a11y}
                value={values.unit}
                disabled={disabled}
                onChange={(event) => setValue("unit", event.target.value)}
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
              <input
                {...a11y}
                value={values.description}
                disabled={disabled}
                onChange={(event) => setValue("description", event.target.value)}
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
          <div className="grid gap-4 sm:grid-cols-2">
            <SinglePicker
              id={id("period")}
              label={t("fields.period.label")}
              hint={hasValues ? t("fields.period.locked") : t("fields.period.hint")}
              error={error("period")}
              value={values.period}
              options={KPI_PERIODS.map((period) => ({
                value: period,
                label: t(`periods.${period}`),
              }))}
              disabled={disabled || hasValues}
              onChange={(period) => setValue("period", period as KpiPeriod)}
            />
            <SinglePicker
              id={id("aggregation")}
              label={t("fields.aggregation.label")}
              hint={t("fields.aggregation.hint")}
              error={error("aggregation")}
              value={values.aggregation}
              options={KPI_AGGREGATIONS.map((aggregation) => ({
                value: aggregation,
                label: t(`aggregations.${aggregation}`),
              }))}
              disabled={disabled}
              onChange={(aggregation) => setValue("aggregation", aggregation as KpiAggregation)}
            />
          </div>
        </Section>

        <Section title={t("sections.values")} description={t("fields.values.hint")}>
          <div
            id={id("values")}
            role="group"
            tabIndex={-1}
            aria-label={t("sections.values")}
            aria-describedby={valuesError ? valuesErrorId : undefined}
            className="space-y-3"
          >
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {periods.map((period) => (
                <Field
                  key={period}
                  id={`${id("values")}-${period}`}
                  label={kpiPeriodLabel(period, values.period, locale)}
                  className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3 space-y-0"
                >
                  {(a11y) => (
                    <input
                      {...a11y}
                      aria-describedby={valuesError ? valuesErrorId : undefined}
                      aria-invalid={valuesError ? true : undefined}
                      inputMode="decimal"
                      autoComplete="off"
                      value={values.values[period] ?? ""}
                      disabled={disabled}
                      onChange={(event) => setEntry(period, event.target.value)}
                      className={`${inputClass} text-right tabular-nums`}
                    />
                  )}
                </Field>
              ))}
            </div>
            <FieldError id={valuesErrorId}>{valuesError}</FieldError>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => setCount(count + KPI_WINDOW)}
              >
                <History className="h-4 w-4" aria-hidden="true" />
                {t("fields.values.earlier")}
              </Button>
              {hidden > 0 && <p role="status">{t("fields.values.hidden", { count: hidden })}</p>}
            </div>
          </div>
        </Section>

        <FormAlert area="kpis" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="kpis"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={editor.pending}
          blocked={editor.meta === null && optionsFailed && !departmentAuthor}
          running={editor.running}
          handlers={item.handlers}
          onInvoke={editor.rememberInvoker}
        >
          <BackToList area="kpis" />
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
