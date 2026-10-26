"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { notifiesOnPublish, type ManageArea } from "@/lib/manage/areas";
import type { AuthoringVerb } from "@/lib/roles";
import { ActionBar } from "./editor-chrome";
import type { EditorIntent, ItemMeta } from "./use-authoring-editor";

/**
 * The buttons of a draft & publish editor (deep-dive decision 06 §L4, §L5,
 * §N2): Save draft, Publish (or Save and publish), Schedule…, Unpublish,
 * Discard changes, Delete, each only with its capability verb and where it
 * applies to the item's state:
 *   - Publish of the draft as it is, when nothing is unsaved and there is
 *     something to publish; with unsaved changes, Save and publish;
 *   - Unpublish while a published version exists;
 *   - Discard changes while a published version exists and the draft
 *     differs from it (a department author's discard needs one, §N2; a
 *     moderator deletes a never-published draft instead);
 *   - Delete and Schedule… for the roles that hold them (moderators).
 * Publish, Unpublish, Discard and Delete ask first (ConfirmDialog, §L5);
 * publishing an announcement or an event says that it notifies its
 * audience now. Presentation only: the editor runs the actions.
 */

export type PublishBarHandlers = {
  saveDraft: () => void;
  saveAndPublish: () => void;
  publish: () => void;
  unpublish: () => void;
  discard: () => void;
  delete: () => void;
  schedule: () => void;
};

type ConfirmKind = "publish" | "saveAndPublish" | "unpublish" | "discard" | "delete";

/**
 * The editor form's own submit (Enter in a text field saves a draft): the
 * same refusal as the publish bar's `blocked`, so a create whose targeting
 * pickers failed cannot save for everyone by pressing Enter (v0.30).
 */
export function draftSubmit(blocked: boolean, saveDraft: () => void) {
  return (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (!blocked) saveDraft();
  };
}

export function PublishBar({
  area,
  verbs,
  meta,
  dirty,
  pending,
  blocked = false,
  running,
  handlers,
  onInvoke,
  children,
}: {
  area: ManageArea;
  verbs: readonly AuthoringVerb[];
  /** null on a create. */
  meta: ItemMeta | null;
  dirty: boolean;
  pending: boolean;
  /**
   * The saves are refused before any request: a create whose targeting
   * pickers could not load would otherwise reach everyone (decision 02,
   * fail closed). The transitions stay available.
   */
  blocked?: boolean;
  running: EditorIntent | null;
  handlers: PublishBarHandlers;
  /**
   * Called with the button that opens a confirmation or the Schedule…
   * dialog: those dialogs' own buttons unmount, so a conflict dialog after
   * them returns the focus here.
   */
  onInvoke?: (element: HTMLElement) => void;
  /** More controls at the end (the back link). */
  children?: ReactNode;
}) {
  const t = useTranslations("manage.common");
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const creating = meta === null;
  const label = (intent: EditorIntent, text: string) =>
    running === intent ? t("actions.working") : text;

  const buttons = new Set(publishBarButtons(verbs, meta, dirty));
  const showSaveDraft = buttons.has("saveDraft");
  // A create publishes with "Publish", an edit with unsaved changes with
  // "Save and publish": both save the form and publish it.
  const showSaveAndPublish = buttons.has("saveAndPublish") || (creating && buttons.has("publish"));
  const showPublish = !creating && buttons.has("publish");
  const showSchedule = buttons.has("schedule");
  const showUnpublish = buttons.has("unpublish");
  const showDiscard = buttons.has("discard");
  const showDelete = buttons.has("delete");

  const run = (kind: ConfirmKind) => {
    setConfirm(null);
    handlers[kind]();
  };

  const publishBody = notifiesOnPublish(area)
    ? t("confirm.publishNotifies")
    : t("confirm.publishBody");

  const confirmButton = (
    kind: ConfirmKind,
    text: string,
    title: string,
    description: string,
    confirmLabel: string,
    tone: "default" | "destructive",
    variant: "default" | "outline" | "destructive" = "outline",
  ) => (
    <ConfirmDialog
      open={confirm === kind}
      onOpenChange={(open) => setConfirm(open ? kind : null)}
      trigger={
        <Button
          type="button"
          variant={variant}
          disabled={pending || (blocked && kind === "saveAndPublish")}
          onClick={(event) => onInvoke?.(event.currentTarget)}
        >
          {text}
        </Button>
      }
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone={tone}
      pending={pending}
      onConfirm={() => run(kind)}
    />
  );

  return (
    <ActionBar label={t("actions.toolbar")}>
      {showSaveDraft && (
        <Button
          type="button"
          variant={showSaveAndPublish || showPublish ? "outline" : "default"}
          // Nothing to save on an unchanged item (an empty draft save would
          // advance the revision and show "Changes pending").
          disabled={pending || blocked || (!creating && !dirty)}
          onClick={handlers.saveDraft}
        >
          {label(creating ? "create" : "saveDraft", t("actions.saveDraft"))}
        </Button>
      )}
      {showSaveAndPublish &&
        confirmButton(
          "saveAndPublish",
          label("saveAndPublish", creating ? t("actions.publish") : t("actions.saveAndPublish")),
          t("confirm.publishTitle"),
          publishBody,
          t("confirm.publishConfirm"),
          "default",
          "default",
        )}
      {showPublish &&
        confirmButton(
          "publish",
          label("publish", t("actions.publish")),
          t("confirm.publishTitle"),
          publishBody,
          t("confirm.publishConfirm"),
          "default",
          "default",
        )}
      {showSchedule && (
        <Button
          type="button"
          variant="outline"
          disabled={pending || blocked}
          onClick={(event) => {
            onInvoke?.(event.currentTarget);
            handlers.schedule();
          }}
        >
          {label("schedule", t("actions.schedule"))}
        </Button>
      )}
      {showUnpublish &&
        confirmButton(
          "unpublish",
          label("unpublish", t("actions.unpublish")),
          t("confirm.unpublishTitle"),
          t("confirm.unpublishBody"),
          t("confirm.unpublishConfirm"),
          "default",
        )}
      {showDiscard &&
        confirmButton(
          "discard",
          label("discard", t("actions.discard")),
          t("confirm.discardTitle"),
          t("confirm.discardBody"),
          t("confirm.discardConfirm"),
          "destructive",
        )}
      <span className="flex-1" aria-hidden="true" />
      {children}
      {showDelete &&
        confirmButton(
          "delete",
          label("delete", t("actions.delete")),
          t("confirm.deleteTitle"),
          t("confirm.deleteBody"),
          t("confirm.deleteConfirm"),
          "destructive",
          "destructive",
        )}
    </ActionBar>
  );
}

export type PublishBarButton =
  "saveDraft" | "saveAndPublish" | "publish" | "schedule" | "unpublish" | "discard" | "delete";

/**
 * Which buttons a state shows, in order (the rules of the header). On a
 * create, "publish" saves and publishes the new item.
 */
export function publishBarButtons(
  verbs: readonly AuthoringVerb[],
  meta: Pick<ItemMeta, "status" | "publishedAt"> | null,
  dirty: boolean,
): PublishBarButton[] {
  const can = (verb: AuthoringVerb) => verbs.includes(verb);
  const creating = meta === null;
  const buttons: PublishBarButton[] = [];
  if (creating ? can("create") : can("edit")) buttons.push("saveDraft");
  if (can("publish") && (creating ? can("create") : can("edit") && dirty)) {
    buttons.push(creating ? "publish" : "saveAndPublish");
  }
  if (!creating && !dirty && can("publish") && meta.status !== "published") buttons.push("publish");
  if (can("schedule") && (creating ? can("create") : can("edit"))) buttons.push("schedule");
  if (!creating && can("unpublish") && meta.publishedAt != null) buttons.push("unpublish");
  if (!creating && can("discard") && meta.publishedAt != null && meta.status === "modified") {
    buttons.push("discard");
  }
  if (!creating && can("delete")) buttons.push("delete");
  return buttons;
}
