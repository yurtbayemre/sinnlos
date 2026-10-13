"use client";

import { useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { STAFF_ROLES, type AnnouncementEditable } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import {
  discardAnnouncement,
  deleteAnnouncement,
  publishAnnouncement,
  saveAnnouncement,
  unpublishAnnouncement,
} from "@/lib/manage/announcement-actions";
import { fieldInputId } from "@/lib/manage/errors";
import {
  announcementValuesFromEditable,
  emptyAnnouncementValues,
  scheduleValuesFromEditable,
  type AnnouncementValues,
} from "@/lib/manage/values";
import type { DepartmentOption, TeamOption } from "@/lib/loaders/manage/options";
import { CheckboxField, CheckboxList, Field, inputClass } from "./form-controls";
import { DateTimeField, DayField } from "./date-fields";
import { ConflictDialog, EditorStatus, FormAlert, useFieldError } from "./editor-chrome";
import { MarkdownEditor } from "./markdown-editor";
import { SinglePicker } from "./pickers";
import { PublishBar } from "./publish-bar";
import { ScheduleDialog } from "./schedule-dialog";
import { useItemEditor, type ItemActions } from "./use-item-editor";
import {
  BackToList,
  OptionsNotice,
  PinnedDepartment,
  RetargetNotice,
  Section,
} from "./editor-parts";

const FORM_ID = "announcement";

/** The fields in form order (the focus goes to the first refused one). */
const FIELD_ORDER = [
  "title",
  "body",
  "pinned",
  "expiresAt",
  "department",
  "team",
  "audienceRoles",
  "requiresAck",
  "ackDeadline",
  "publishAt",
] as const;

const ACTIONS: ItemActions = {
  save: saveAnnouncement,
  publish: publishAnnouncement,
  unpublish: unpublishAnnouncement,
  discard: discardAnnouncement,
  remove: deleteAnnouncement,
};

/**
 * The announcement form (deep-dive decision 06 §A, §L4, §N2, §N4): title,
 * Markdown body, pinning, expiry, the audience (department AND team AND
 * roles) and the read confirmation, with the publish bar.
 *
 * A department author (`access.roleClass` departmentAuthor) gets the same
 * form without Pinned, Requires read confirmation and its deadline, without
 * Schedule… and Delete: their department is shown read-only and sent
 * pinned and the team picker lists only that department's teams. The role
 * picker offers the staff role types (guests cannot read announcements).
 */
export function AnnouncementEditor({
  editable,
  access,
  timeZone,
  departments,
  teams,
  optionsFailed,
  optionsTruncated,
  ownDepartment,
}: {
  editable: AnnouncementEditable | null;
  access: AreaAccess;
  timeZone: string;
  departments: DepartmentOption[];
  teams: TeamOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
  /** A department author's department (pinned), else null. */
  ownDepartment: { documentId: string; name: string } | null;
}) {
  const t = useTranslations("manage.announcements");
  const tc = useTranslations("manage.common");
  const departmentAuthor = access.roleClass === "departmentAuthor";
  const toValues = useCallback(
    (source: AnnouncementEditable) => announcementValuesFromEditable(source, timeZone),
    [timeZone],
  );
  const item = useItemEditor<AnnouncementValues, AnnouncementEditable>({
    area: "announcements",
    formId: FORM_ID,
    editable,
    toValues,
    emptyValues: emptyAnnouncementValues(ownDepartment?.documentId ?? ""),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("announcements", editor.fieldErrors);
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;
  const targetingLocked = disabled || optionsFailed;

  const departmentOptions = useMemo(
    () => [
      { value: "", label: tc("targeting.everyone") },
      ...departments.map((d) => ({ value: d.documentId, label: d.name })),
    ],
    [departments, tc],
  );
  // AND: a team outside the chosen department would reach nobody, so the
  // picker offers the chosen department's teams (and the current one).
  const teamOptions = useMemo(() => {
    const department = departmentAuthor ? ownDepartment?.documentId : values.department;
    const offered = teams.filter(
      (team) => !department || team.department === department || team.documentId === values.team,
    );
    return [
      { value: "", label: tc("targeting.noTeam") },
      ...offered.map((team) => ({ value: team.documentId, label: team.name })),
    ];
  }, [teams, departmentAuthor, ownDepartment, values.department, values.team, tc]);
  // The staff role types: guests cannot read announcements (no grant), and
  // a department author may target staff roles only (§N4). A role set in
  // the admin panel stays selected (CheckboxList keeps unknown values).
  const roleOptions = STAFF_ROLES.map((role) => ({
    value: role,
    label: tc(`targeting.roles.${role}`),
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
            id={id("body")}
            label={t("fields.body.label")}
            hint={tc("markdown.hint")}
            error={error("body")}
            value={values.body}
            disabled={disabled}
            onChange={(body) => setValue("body", body)}
          />
          {!departmentAuthor && (
            <CheckboxField
              id={id("pinned")}
              label={t("fields.pinned.label")}
              hint={t("fields.pinned.hint")}
              error={error("pinned")}
              checked={values.pinned}
              disabled={disabled}
              onChange={(pinned) => setValue("pinned", pinned)}
            />
          )}
          <DateTimeField
            id={id("expiresAt")}
            legend={t("fields.expiresAt.label")}
            hint={t("fields.expiresAt.hint")}
            error={error("expiresAt")}
            date={values.expiresDate}
            time={values.expiresTime}
            timeZone={timeZone}
            disabled={disabled}
            onDateChange={(expiresDate) => setValue("expiresDate", expiresDate)}
            onTimeChange={(expiresTime) => setValue("expiresTime", expiresTime)}
          />
        </Section>

        <Section title={t("sections.audience")} description={t("sections.audienceHint")}>
          {editable?.needsRetarget && (
            <RetargetNotice
              checked={item.retarget}
              disabled={targetingLocked}
              onChange={item.setRetarget}
            />
          )}
          <OptionsNotice failed={optionsFailed} truncated={optionsTruncated} />
          {departmentAuthor ? (
            <PinnedDepartment name={ownDepartment?.name ?? ""} />
          ) : (
            <SinglePicker
              id={id("department")}
              label={t("fields.department.label")}
              error={error("department")}
              value={values.department}
              options={departmentOptions}
              disabled={targetingLocked}
              onChange={(department) => setValue("department", department)}
            />
          )}
          <SinglePicker
            id={id("team")}
            label={t("fields.team.label")}
            error={error("team")}
            value={values.team}
            options={teamOptions}
            disabled={targetingLocked}
            onChange={(team) => setValue("team", team)}
          />
          <CheckboxList
            id={id("audienceRoles")}
            legend={t("fields.audienceRoles.label")}
            hint={t("fields.audienceRoles.hint")}
            error={error("audienceRoles")}
            options={roleOptions}
            selected={values.audienceRoles}
            disabled={targetingLocked}
            onChange={(audienceRoles) => setValue("audienceRoles", audienceRoles)}
          />
        </Section>

        {!departmentAuthor && (
          <Section title={t("sections.confirmation")}>
            <CheckboxField
              id={id("requiresAck")}
              label={t("fields.requiresAck.label")}
              hint={t("fields.requiresAck.hint")}
              error={error("requiresAck")}
              checked={values.requiresAck}
              disabled={disabled}
              onChange={(requiresAck) =>
                item.setValues((v) => ({
                  ...v,
                  requiresAck,
                  // A deadline needs the confirmation (ackDeadlineWithoutAck).
                  ackDeadline: requiresAck ? v.ackDeadline : "",
                }))
              }
            />
            <DayField
              id={id("ackDeadline")}
              label={t("fields.ackDeadline.label")}
              hint={t("fields.ackDeadline.hint")}
              error={error("ackDeadline")}
              value={values.ackDeadline}
              disabled={disabled || !values.requiresAck}
              onChange={(ackDeadline) => setValue("ackDeadline", ackDeadline)}
            />
          </Section>
        )}

        <FormAlert area="announcements" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="announcements"
          verbs={access.verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={editor.pending}
          blocked={editor.meta === null && optionsFailed}
          running={editor.running}
          handlers={item.handlers}
          onInvoke={editor.rememberInvoker}
        >
          <BackToList area="announcements" />
        </PublishBar>
      </form>

      {access.verbs.includes("schedule") && (
        <ScheduleDialog
          area="announcements"
          formId={FORM_ID}
          open={item.scheduleOpen}
          initial={scheduleValuesFromEditable(editor.meta ?? {}, timeZone)}
          hasSchedule={!!editor.meta?.publishAt}
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
        copyText={[values.title, values.body].filter(Boolean).join("\n\n")}
        pending={editor.pending}
        onReload={item.reload}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </>
  );
}
