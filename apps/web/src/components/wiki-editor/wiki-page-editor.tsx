"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Eye, History } from "lucide-react";
import { useTranslations } from "next-intl";
import type { AuthoringResult, WikiPageEditable, WikiPageResult } from "@sinnlos/domain";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CheckboxField, Field, inputClass, textareaClass } from "@/components/manage/form-controls";
import {
  ConflictDialog,
  EditorStatus,
  FormAlert,
  useFieldError,
} from "@/components/manage/editor-chrome";
import { OptionsNotice, Section } from "@/components/manage/editor-parts";
import { MarkdownEditor } from "@/components/manage/markdown-editor";
import { SinglePicker } from "@/components/manage/pickers";
import { PublishBar } from "@/components/manage/publish-bar";
import { ScheduleDialog } from "@/components/manage/schedule-dialog";
import { useItemEditor, type ItemActions } from "@/components/manage/use-item-editor";
import { fieldInputId } from "@/lib/manage/errors";
import { cn } from "@/lib/utils";
import type { DepartmentOption, TeamOption } from "@/lib/loaders/manage/options";
import type { WikiParentOption } from "@/lib/loaders/manage/wiki";
import { scheduleValuesFromEditable } from "@/lib/manage/values";
import {
  deleteWikiPage,
  discardWikiPage,
  publishWikiPage,
  saveWikiPage,
  unpublishWikiPage,
} from "@/lib/manage/wiki-page-actions";
import {
  wikiEditPath,
  wikiHistoryPath,
  wikiPagePath,
  wikiSpacePath,
} from "@/lib/manage/wiki-paths";
import {
  emptyWikiPageValues,
  wikiPageValuesFromEditable,
  type WikiPageValues,
} from "@/lib/manage/wiki-values";
import type { AuthoringVerb, Capabilities } from "@/lib/roles";

const FORM_ID = "wiki-page";

/** The fields in form order (the focus goes to the first refused one). */
const FIELD_ORDER = [
  "title",
  "summary",
  "body",
  "space",
  "parent",
  "order",
  "tags",
  "tocEnabled",
  "department",
  "team",
  "revisionSummary",
  "publishAt",
] as const;

const ACTIONS: ItemActions = {
  save: saveWikiPage,
  publish: publishWikiPage,
  unpublish: unpublishWikiPage,
  discard: discardWikiPage,
  remove: deleteWikiPage,
};

export interface WikiEditorSpace {
  documentId: string;
  name: string;
  slug: string;
}

/**
 * The wiki editor (deep-dive decision 06 §J2, §L4, §L5; batch 16 plan,
 * lane 16C item 5): a page's title, summary, Markdown text, its place in
 * the space (parent and order), tags and the table-of-contents switch, the
 * change note for the history; for moderators also its department and team
 * (whose head and lead may edit it) and Schedule….
 *
 * Who sees what (the cms decides every write, K17, K18):
 *   - a department head or team lead creating, and the page's author, its
 *     department's head and its team's lead editing, save drafts that only
 *     they and moderators see, and publish them; a draft that was never
 *     published can be deleted by its author ("Delete draft": the discard
 *     of §J2, which deletes it);
 *   - moderators also schedule, unpublish (once the cms grants it, K20) and
 *     delete.
 * Saves send only what changed; a 412 opens the conflict dialog (Reload or
 * Overwrite); a parent that would put the page below itself is refused
 * (`parentCycle`) under the parent picker, for every writer.
 */
export function WikiPageEditor({
  editable,
  space,
  wikiPages,
  timeZone,
  parentOptions,
  parentsFailed,
  parentsTruncated,
  departments,
  teams,
  optionsFailed,
  optionsTruncated,
}: {
  editable: WikiPageEditable | null;
  /** The page's space (a create: the space it was opened in). */
  space: WikiEditorSpace;
  wikiPages: Capabilities["wikiPages"];
  timeZone: string;
  parentOptions: WikiParentOption[];
  parentsFailed: boolean;
  parentsTruncated: boolean;
  /** Moderators only (the department and team pickers). */
  departments: DepartmentOption[];
  teams: TeamOption[];
  optionsFailed: boolean;
  optionsTruncated: boolean;
}) {
  const t = useTranslations("manage.wiki.editor");
  const tc = useTranslations("manage.common");
  const moderator = editable ? editable.roleClass === "moderator" : wikiPages.edit === "any";
  const creating = editable === null;
  const itemPath = useCallback(
    (data: AuthoringResult) => {
      const page = data as WikiPageResult;
      return wikiEditPath(page.spaceSlug ?? space.slug, page.slug, page.documentId);
    },
    [space.slug],
  );
  const item = useItemEditor<WikiPageValues, WikiPageEditable>({
    area: "wiki",
    formId: FORM_ID,
    editable,
    toValues: wikiPageValuesFromEditable,
    emptyValues: emptyWikiPageValues(),
    fieldOrder: FIELD_ORDER,
    actions: ACTIONS,
    extraInput: creating ? { space: space.documentId } : undefined,
    drafts: true,
    itemPath,
    listPath: wikiSpacePath(space.slug),
  });
  const { values, setValue, editor } = item;
  const error = useFieldError("wiki", editor.fieldErrors, "editor");
  const id = (field: string) => fieldInputId(FORM_ID, field);
  const disabled = editor.pending;
  const [confirmDeleteDraft, setConfirmDeleteDraft] = useState(false);

  // What the publish bar offers (its rules decide the state): the row
  // classes create (department heads, team leads), edit, publish and
  // discard; moderators also schedule, unpublish and delete.
  const verbs = useMemo(() => {
    const list: AuthoringVerb[] = [];
    if (creating ? wikiPages.create : wikiPages.edit !== "none") {
      list.push(creating ? "create" : "edit", "publish", "discard");
    }
    if (moderator && wikiPages.schedule) list.push("schedule");
    if (moderator && wikiPages.unpublish) list.push("unpublish");
    if (moderator && wikiPages.delete) list.push("delete");
    return list;
  }, [creating, moderator, wikiPages]);

  const parentChoices = useMemo(() => {
    const known = new Set(parentOptions.map((option) => option.documentId));
    return [
      { value: "", label: t("fields.parent.none") },
      ...parentOptions.map((option) => ({ value: option.documentId, label: option.label })),
      // A parent the list does not hold (a draft-only page) stays selected and named.
      ...(values.parent && !known.has(values.parent)
        ? [{ value: values.parent, label: t("fields.parent.current") }]
        : []),
    ];
  }, [parentOptions, values.parent, t]);
  const departmentChoices = useMemo(
    () => [
      { value: "", label: t("fields.department.none") },
      ...departments.map((d) => ({ value: d.documentId, label: d.name })),
      ...(values.department && !departments.some((d) => d.documentId === values.department)
        ? [{ value: values.department, label: values.department }]
        : []),
    ],
    [departments, values.department, t],
  );
  const teamChoices = useMemo(
    () => [
      { value: "", label: t("fields.team.none") },
      ...teams.map((team) => ({ value: team.documentId, label: team.name })),
      ...(values.team && !teams.some((team) => team.documentId === values.team)
        ? [{ value: values.team, label: values.team }]
        : []),
    ],
    [teams, values.team, t],
  );

  const published = editor.meta?.publishedAt != null;
  // A page that was never published: its author (and moderators, who have
  // Delete) may discard it, which deletes it (§J2).
  const canDeleteDraft =
    !creating &&
    !moderator &&
    editable?.canDiscardUnpublished === true &&
    editor.meta?.publishedAt === null;
  const link = buttonVariants({ variant: "ghost" });

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
        <EditorStatus meta={editor.meta} dirty={item.dirty} showOwner={false} />

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
          <Field
            id={id("summary")}
            label={t("fields.summary.label")}
            hint={t("fields.summary.hint")}
            error={error("summary")}
          >
            {(a11y) => (
              <textarea
                {...a11y}
                rows={2}
                value={values.summary}
                disabled={disabled}
                onChange={(event) => setValue("summary", event.target.value)}
                className={cn(textareaClass, "min-h-16 font-sans")}
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
        </Section>

        <Section title={t("sections.placement")}>
          {error("space") && (
            <p id={id("space")} className="text-sm text-destructive" tabIndex={-1}>
              {error("space")}
            </p>
          )}
          {(parentsFailed || parentsTruncated) && (
            <p
              role={parentsFailed ? "alert" : undefined}
              className="flex items-start gap-2 rounded-xl border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {parentsFailed ? t("parentsFailed") : t("parentsTruncated")}
            </p>
          )}
          <SinglePicker
            id={id("parent")}
            label={t("fields.parent.label")}
            hint={t("fields.parent.hint")}
            error={error("parent")}
            value={values.parent}
            options={parentChoices}
            disabled={disabled || parentsFailed}
            onChange={(parent) => setValue("parent", parent)}
          />
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
          <Field
            id={id("tags")}
            label={t("fields.tags.label")}
            hint={t("fields.tags.hint")}
            error={error("tags")}
          >
            {(a11y) => (
              <input
                {...a11y}
                value={values.tags}
                disabled={disabled}
                autoComplete="off"
                onChange={(event) => setValue("tags", event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <CheckboxField
            id={id("tocEnabled")}
            label={t("fields.tocEnabled.label")}
            hint={t("fields.tocEnabled.hint")}
            error={error("tocEnabled")}
            checked={values.tocEnabled}
            disabled={disabled}
            onChange={(tocEnabled) => setValue("tocEnabled", tocEnabled)}
          />
        </Section>

        {moderator && (
          <Section title={t("sections.responsibility")}>
            <OptionsNotice failed={optionsFailed} truncated={optionsTruncated} />
            <SinglePicker
              id={id("department")}
              label={t("fields.department.label")}
              hint={t("fields.department.hint")}
              error={error("department")}
              value={values.department}
              options={departmentChoices}
              disabled={disabled || optionsFailed}
              onChange={(department) => setValue("department", department)}
            />
            <SinglePicker
              id={id("team")}
              label={t("fields.team.label")}
              hint={t("fields.team.hint")}
              error={error("team")}
              value={values.team}
              options={teamChoices}
              disabled={disabled || optionsFailed}
              onChange={(team) => setValue("team", team)}
            />
          </Section>
        )}

        {!creating && (
          <Section title={t("sections.note")}>
            <Field
              id={id("revisionSummary")}
              label={t("fields.revisionSummary.label")}
              hint={t("fields.revisionSummary.hint")}
              error={error("revisionSummary")}
            >
              {(a11y) => (
                <input
                  {...a11y}
                  value={values.revisionSummary}
                  maxLength={255}
                  disabled={disabled}
                  onChange={(event) => setValue("revisionSummary", event.target.value)}
                  className={inputClass}
                />
              )}
            </Field>
          </Section>
        )}

        <FormAlert area="wiki" scope="editor" failure={editor.failure} alertRef={editor.alertRef} />
        <PublishBar
          area="wiki"
          verbs={verbs}
          meta={editor.meta}
          dirty={item.dirty}
          pending={editor.pending}
          running={editor.running}
          handlers={item.handlers}
          onInvoke={editor.rememberInvoker}
        >
          {canDeleteDraft && (
            <ConfirmDialog
              open={confirmDeleteDraft}
              onOpenChange={setConfirmDeleteDraft}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={(event) => editor.rememberInvoker(event.currentTarget)}
                >
                  {editor.running === "discard" ? tc("actions.working") : t("deleteDraft")}
                </Button>
              }
              title={t("deleteDraftTitle")}
              description={t("deleteDraftBody")}
              confirmLabel={t("deleteDraftConfirm")}
              pending={disabled}
              onConfirm={() => {
                setConfirmDeleteDraft(false);
                item.handlers.discard();
              }}
            />
          )}
          {!creating && editable && (
            <Link
              href={wikiHistoryPath(space.slug, editable.slug, editable.documentId)}
              className={link}
            >
              <History className="h-4 w-4" aria-hidden="true" />
              {t("history")}
            </Link>
          )}
          {published && editable && (
            <Link href={wikiPagePath(space.slug, editable.slug)} className={link}>
              <Eye className="h-4 w-4" aria-hidden="true" />
              {t("viewPage")}
            </Link>
          )}
        </PublishBar>
      </form>

      {verbs.includes("schedule") && (
        <ScheduleDialog
          area="wiki"
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
