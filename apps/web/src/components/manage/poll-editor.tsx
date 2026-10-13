"use client";

import { useCallback, useState } from "react";
import { Lock, Plus, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import {
  MAX_POLL_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  type PollEditable,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AreaAccess } from "@/lib/manage/access";
import { fieldInputId } from "@/lib/manage/errors";
import { closePoll, deletePoll, savePoll } from "@/lib/manage/poll-actions";
import { normalizeGuestAccess } from "@/lib/poll-guest-access";
import { emptyPollValues, pollValuesFromEditable, type PollValues } from "@/lib/manage/values";
import type { DepartmentOption } from "@/lib/loaders/manage/options";
import { formatInstant } from "@/lib/date-format";
import { CheckboxField, CheckboxList, Field, FieldGroup, inputClass } from "./form-controls";
import { DayField } from "./date-fields";
import { ActionBar, ConflictDialog, FormAlert, useFieldError } from "./editor-chrome";
import { BackToList, OptionsNotice, RetargetNotice, Section } from "./editor-parts";
import { Badge } from "./status-badges";
import { useItemEditor, type ItemActions } from "./use-item-editor";
import { useManageFlash } from "./flash";

const FORM_ID = "poll";

const FIELD_ORDER = [
  "question",
  "options",
  "closesAt",
  "anonymous",
  "departments",
  "visibleToGuests",
  "guestsCanVote",
] as const;

const ACTIONS: ItemActions = { save: savePoll, remove: deletePoll };

/**
 * The poll form (deep-dive decision 06 §A, §L4; moderators only): the
 * question, 2-20 answers of at most 200 characters (the domain's bounds,
 * K7, which replace the old form's local 10), the closing day, anonymity,
 * the departments and the guest switches. A poll is published when it is
 * created and has no drafts; it ends through its closing day, or at once
 * with Close now.
 *
 * After the first vote the answers and the anonymity are frozen
 * (frozenAfterVotes): their inputs are locked with a note, and the save
 * leaves them out. Answers carry a counter-based key, so removing a middle
 * one never re-keys the inputs after it (issue #36).
 */
export function PollEditor({
  editable,
  access,
  timeZone,
  today,
  closed,
  departments,
  optionsFailed,
  optionsTruncated,
}: {
  editable: PollEditable | null;
  access: AreaAccess;
  timeZone: string;
  /** Today in APP_TIME_ZONE (`YYYY-MM-DD`): the earliest closing day the picker offers. */
  today: string;
  /** The poll is closed (closesAt has passed). */
  closed: boolean;
  departments: DepartmentOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
}) {
  const t = useTranslations("manage.polls");
  const tc = useTranslations("manage.common");
  const format = useFormatter();
  const flash = useManageFlash();
  const hasVotes = editable?.hasVotes ?? false;
  const toValues = useCallback(
    (source: PollEditable) => pollValuesFromEditable(source, timeZone),
    [timeZone],
  );
  const item = useItemEditor<PollValues, PollEditable>({
    area: "polls",
    formId: FORM_ID,
    editable,
    toValues,
    emptyValues: emptyPollValues(),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
    extraInput: { hasVotes },
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("polls", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;
  const creating = editor.meta === null;
  const can = (verb: "create" | "edit" | "delete") => access.verbs.includes(verb);
  const [confirm, setConfirm] = useState<"close" | "delete" | null>(null);

  // Stable keys for the answer inputs (see the header): a new answer gets
  // the next number, a removed one takes its key with it.
  const [keys, setKeys] = useState(() => values.options.map((_, i) => i));
  const nextKeyAfter = (current: number[]) => (current.length ? Math.max(...current) + 1 : 0);
  if (keys.length !== values.options.length) {
    // The values were reset (Reload, Discard): fresh keys for the new answers.
    const start = nextKeyAfter(keys);
    setKeys(values.options.map((_, i) => start + i));
  }
  const setOption = (index: number, text: string) =>
    setValue(
      "options",
      values.options.map((option, i) => (i === index ? text : option)),
    );
  const addOption = () => {
    setKeys((previous) => [...previous, nextKeyAfter(previous)]);
    setValue("options", [...values.options, ""]);
  };
  const removeOption = (index: number) => {
    setKeys((previous) => previous.filter((_, i) => i !== index));
    setValue(
      "options",
      values.options.filter((_, i) => i !== index),
    );
  };
  const setGuestAccess = (change: { visibleToGuests?: boolean; guestsCanVote?: boolean }) =>
    item.setValues((v) => ({ ...v, ...normalizeGuestAccess({ ...v, ...change }) }));

  const closeNow = () => {
    if (!editor.meta) return;
    const documentId = editor.meta.documentId;
    setConfirm(null);
    editor.run("close", (version) => closePoll(documentId, version ?? ""), {
      onSuccess: () => {
        // The cms closed it now: today is its closing day.
        item.rebase({ closesDay: today });
        flash(tc("success.closed"));
      },
    });
  };

  const closesAt = formatInstant(format, editable?.closesAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

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
        {(editable || item.dirty) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {editable && (
              <Badge tone={closed ? "neutral" : "success"}>
                {closed ? t("state.closed") : t("state.open")}
              </Badge>
            )}
            {editable && !closed && closesAt && (
              <Badge tone="info">{t("state.closesOn", { date: closesAt })}</Badge>
            )}
            {editable?.needsRetarget && <Badge tone="warning">{tc("status.needsRetarget")}</Badge>}
            {item.dirty && <Badge tone="warning">{tc("status.unsaved")}</Badge>}
          </div>
        )}

        <Section title={t("sections.question")}>
          <Field
            id={id("question")}
            label={t("fields.question.label")}
            error={error("question")}
            required
          >
            {(a11y) => (
              <input
                {...a11y}
                value={values.question}
                placeholder={t("fields.question.placeholder")}
                disabled={disabled}
                onChange={(event) => setValue("question", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>

          <FieldGroup
            id={id("options")}
            legend={t("fields.options.label")}
            hint={
              hasVotes
                ? t("fields.options.frozen")
                : t("fields.options.hint", {
                    min: MIN_POLL_OPTIONS,
                    max: MAX_POLL_OPTIONS,
                    length: MAX_POLL_OPTION_LENGTH,
                  })
            }
            error={error("options")}
            required
          >
            <ol className="space-y-2">
              {values.options.map((option, i) => (
                <li key={keys[i] ?? `extra-${i}`} className="flex items-center gap-2">
                  <input
                    id={i === 0 ? id("options") : `${id("options")}-${i}`}
                    value={option}
                    maxLength={MAX_POLL_OPTION_LENGTH}
                    aria-label={t("fields.options.option", { number: i + 1 })}
                    disabled={disabled || hasVotes}
                    onChange={(event) => setOption(i, event.target.value)}
                    className={inputClass}
                  />
                  {!hasVotes && values.options.length > MIN_POLL_OPTIONS && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={disabled}
                      aria-label={t("fields.options.remove", { number: i + 1 })}
                      onClick={() => removeOption(i)}
                      className="shrink-0"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                  {hasVotes && (
                    <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                </li>
              ))}
            </ol>
            {!hasVotes && values.options.length < MAX_POLL_OPTIONS && (
              <Button type="button" variant="outline" disabled={disabled} onClick={addOption}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("fields.options.add")}
              </Button>
            )}
          </FieldGroup>

          <DayField
            id={id("closesAt")}
            label={t("fields.closesAt.label")}
            hint={t("fields.closesAt.hint")}
            error={error("closesAt")}
            value={values.closesDay}
            min={today}
            disabled={disabled}
            onChange={(closesDay) => setValue("closesDay", closesDay)}
          />
          <CheckboxField
            id={id("anonymous")}
            label={t("fields.anonymous.label")}
            hint={hasVotes ? t("fields.anonymous.frozen") : t("fields.anonymous.hint")}
            error={error("anonymous")}
            checked={values.anonymous}
            disabled={disabled || hasVotes}
            onChange={(anonymous) => setValue("anonymous", anonymous)}
          />
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

        <Section title={t("sections.guestAccess")} description={t("fields.guestAccess.hint")}>
          <CheckboxField
            id={id("visibleToGuests")}
            label={t("fields.visibleToGuests.label")}
            error={error("visibleToGuests")}
            checked={values.visibleToGuests}
            disabled={disabled}
            onChange={(visibleToGuests) => setGuestAccess({ visibleToGuests })}
          />
          <CheckboxField
            id={id("guestsCanVote")}
            label={t("fields.guestsCanVote.label")}
            error={error("guestsCanVote")}
            checked={values.guestsCanVote}
            disabled={disabled || !values.visibleToGuests}
            onChange={(guestsCanVote) => setGuestAccess({ guestsCanVote })}
          />
        </Section>

        <FormAlert area="polls" failure={editor.failure} alertRef={editor.alertRef} />
        <ActionBar label={tc("actions.toolbar")}>
          {(creating ? can("create") : can("edit")) && (
            // A create without the department list could only reach everyone
            // (decision 02: fail closed), so it waits for a reload.
            <Button type="submit" disabled={disabled || (creating && optionsFailed)}>
              {editor.running === "create" ||
              editor.running === "saveAndPublish" ||
              editor.running === "save"
                ? tc("actions.working")
                : creating
                  ? tc("actions.create")
                  : tc("actions.save")}
            </Button>
          )}
          {!creating && can("edit") && !closed && (
            <ConfirmDialog
              open={confirm === "close"}
              onOpenChange={(open) => setConfirm(open ? "close" : null)}
              trigger={
                <Button type="button" variant="outline" disabled={disabled}>
                  {editor.running === "close" ? tc("actions.working") : tc("actions.closeNow")}
                </Button>
              }
              title={tc("confirm.closeTitle")}
              description={tc("confirm.closeBody")}
              confirmLabel={tc("confirm.closeConfirm")}
              tone="default"
              pending={disabled}
              onConfirm={closeNow}
            />
          )}
          <span className="flex-1" aria-hidden="true" />
          <BackToList area="polls" />
          {!creating && can("delete") && (
            <ConfirmDialog
              open={confirm === "delete"}
              onOpenChange={(open) => setConfirm(open ? "delete" : null)}
              trigger={
                <Button type="button" variant="destructive" disabled={disabled}>
                  {editor.running === "delete" ? tc("actions.working") : tc("actions.delete")}
                </Button>
              }
              title={tc("confirm.deleteTitle")}
              description={tc("confirm.deleteBody")}
              confirmLabel={tc("confirm.deleteConfirm")}
              pending={disabled}
              onConfirm={() => {
                setConfirm(null);
                item.handlers.delete();
              }}
            />
          )}
        </ActionBar>
      </form>

      <ConflictDialog
        conflict={editor.conflict}
        copyText={[values.question, ...values.options].filter(Boolean).join("\n")}
        pending={editor.pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
