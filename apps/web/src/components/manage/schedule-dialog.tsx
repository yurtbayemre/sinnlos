"use client";

import { useState, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/confirm-dialog";
import { SCHEDULE_FIELDS, type ManageArea } from "@/lib/manage/areas";
import { fieldInputId } from "@/lib/manage/errors";
import { emptyScheduleValues, type ScheduleValues } from "@/lib/manage/values";
import { DateTimeField } from "./date-fields";

/**
 * The Schedule… dialog (deep-dive decision 06 §D, §L4; moderators only):
 * when the item publishes and, for quick links, when it is withdrawn, as a
 * date and a time in APP_TIME_ZONE. Saving it saves the draft with the
 * schedule (`status=draft`): the schedule takes effect at once, also for a
 * published item, which the dialog says. "Remove the schedule" saves both
 * as empty. The editor runs the save; a refusal (scheduleInPast,
 * unpublishBeforePublish, a clock-change time) shows under its field here,
 * and the dialog closes only on success.
 */
export function ScheduleDialog({
  area,
  formId,
  open,
  initial,
  hasSchedule,
  timeZone,
  pending,
  errorText,
  returnFocus,
  onOpenChange,
  onSave,
}: {
  area: ManageArea;
  formId: string;
  open: boolean;
  /** The item's current schedule as inputs. */
  initial: ScheduleValues;
  /** The item has a schedule to remove. */
  hasSchedule: boolean;
  timeZone: string;
  pending: boolean;
  /** The text of a refused schedule field, if any. */
  errorText: (field: "publishAt" | "unpublishAt") => string | undefined;
  /** The control that opened the dialog: the focus goes back to it on close. */
  returnFocus?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onSave: (schedule: ScheduleValues) => void;
}) {
  const t = useTranslations("manage.common.schedule");
  const tActions = useTranslations("manage.common.actions");
  const [values, setValues] = useState(initial);
  // Every opening starts from the item's current schedule (state derived
  // from the `open` prop during render, React's pattern for a reset).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValues(initial);
  }
  const fields = SCHEDULE_FIELDS[area];
  const set = (patch: Partial<ScheduleValues>) => setValues((v) => ({ ...v, ...patch }));

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      title={t("title")}
      description={t("description")}
    >
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(values);
        }}
      >
        {fields.includes("publishAt") && (
          <DateTimeField
            id={fieldInputId(formId, "publishAt")}
            legend={t("publishAt")}
            date={values.publishDate}
            time={values.publishTime}
            timeZone={timeZone}
            error={errorText("publishAt")}
            disabled={pending}
            onDateChange={(publishDate) => set({ publishDate })}
            onTimeChange={(publishTime) => set({ publishTime })}
          />
        )}
        {fields.includes("unpublishAt") && (
          <DateTimeField
            id={fieldInputId(formId, "unpublishAt")}
            legend={t("unpublishAt")}
            date={values.unpublishDate}
            time={values.unpublishTime}
            timeZone={timeZone}
            error={errorText("unpublishAt")}
            disabled={pending}
            onDateChange={(unpublishDate) => set({ unpublishDate })}
            onTimeChange={(unpublishTime) => set({ unpublishTime })}
          />
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {hasSchedule && (
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onSave(emptyScheduleValues())}
            >
              {t("clear")}
            </Button>
          )}
          <Dialog.Close asChild>
            <Button type="button" variant="outline" disabled={pending}>
              <CancelText />
            </Button>
          </Dialog.Close>
          <Button type="submit" disabled={pending}>
            {pending ? tActions("working") : t("save")}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function CancelText() {
  const t = useTranslations("common");
  return <>{t("cancel")}</>;
}
