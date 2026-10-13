"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AuthoringDocumentStatus, AuthoringResult } from "@sinnlos/domain";
import { startCmsAction, type CommonCode } from "@/lib/action-result";
import type { AuthoringActionResult } from "@/lib/manage/authoring-action";
import { fieldInputId, sortFieldErrors, type ManageErrorCode } from "@/lib/manage/errors";

/**
 * The state machine of one /manage editor (deep-dive decision 06 §L3, §L4):
 * the item's meta (version, status, schedule) as the last answer left it,
 * the running action, the errors of the last failure and the conflict
 * dialog. The area editors own their values; they hand each action as a
 * call that takes the version to send.
 *
 *  - Every mutation but a create sends the version the editor last saw
 *    (`If-Match`); every success replaces it with the cms's answer.
 *  - A 412 opens the conflict dialog with the cms's current version:
 *    "Overwrite" repeats the same call with that version (an explicit
 *    choice) and then reloads the item, "Reload" re-reads the page and
 *    resets the form to it.
 *  - A 400 sorts its fields: the form's own fields get their texts and
 *    the focus moves to the first one; `_form` (neverPublished) and keys
 *    the form cannot show get a text above the actions, which takes the
 *    focus (role="alert").
 *  - Other failures (forbidden, notFound, unavailable, failed) are one
 *    text above the actions.
 * Nothing here formats a Strapi message: only codes reach the UI (AC02).
 */

export interface ItemMeta {
  documentId: string;
  version: string;
  status: AuthoringDocumentStatus;
  publishedAt: string | null;
  publishAt: string | null;
  unpublishAt: string | null;
  scheduleError: string | null;
}

/** The meta of an `editable` answer. */
export function metaOf(source: {
  documentId: string;
  version: string;
  status: AuthoringDocumentStatus;
  publishedAt: string | null;
  publishAt?: string | null;
  unpublishAt?: string | null;
  scheduleError?: string | null;
}): ItemMeta {
  return {
    documentId: source.documentId,
    version: source.version,
    status: source.status,
    publishedAt: source.publishedAt ?? null,
    publishAt: source.publishAt ?? null,
    unpublishAt: source.unpublishAt ?? null,
    scheduleError: source.scheduleError ?? null,
  };
}

/** The meta after a write answer (fields the answer leaves out keep their value). */
export function mergeMeta(meta: ItemMeta | null, data: AuthoringResult): ItemMeta {
  return {
    documentId: data.documentId,
    version: data.version,
    status: data.status,
    publishedAt: data.publishedAt ?? null,
    publishAt: data.publishAt !== undefined ? data.publishAt : (meta?.publishAt ?? null),
    unpublishAt: data.unpublishAt !== undefined ? data.unpublishAt : (meta?.unpublishAt ?? null),
    scheduleError:
      data.scheduleError !== undefined ? data.scheduleError : (meta?.scheduleError ?? null),
  };
}

/** A failure the form shows above its actions. */
export type FormFailure =
  { kind: "code"; code: ManageErrorCode } | { kind: "common"; code: CommonCode | "unshown" };

/** The 412 dialog: the cms's current version (null without one) and what to repeat. */
export interface ConflictState {
  version: string | null;
  intent: EditorIntent;
  call: ActionCall;
  options: RunOptions;
}

/** The actions the editors run (labels and the button that shows "Working…"). */
export type EditorIntent =
  | "create"
  | "saveDraft"
  | "saveAndPublish"
  | "save"
  | "schedule"
  | "publish"
  | "unpublish"
  | "discard"
  | "delete"
  | "close";

export type ActionCall = (version: string | undefined) => Promise<AuthoringActionResult>;

/** The intents that send the form's values. */
const SAVE_INTENTS: readonly EditorIntent[] = [
  "create",
  "saveDraft",
  "saveAndPublish",
  "save",
  "schedule",
];

export interface RunOptions {
  /** After `ok: true`, with the answer's data (null: the document is gone). */
  onSuccess?: (data: AuthoringResult | null) => void | Promise<void>;
  /**
   * After a refusal other than a conflict, with the refused fields (empty
   * for a failure without fields): a dialog that started the action can
   * close so the form's errors are reachable.
   */
  onFailure?: (fields: Readonly<Record<string, string>>) => void;
}

/** The DOM element of a field: its control, or the first focusable inside it. */
function focusField(formId: string, field: string): boolean {
  const element = document.getElementById(fieldInputId(formId, field));
  if (!element) return false;
  const target = element.matches("input, textarea, select, button")
    ? element
    : element.querySelector<HTMLElement>("input, textarea, select, button");
  if (!target) return false;
  target.focus();
  // A control in a hidden panel or a disabled one does not take the focus:
  // the caller falls back to the alert.
  return document.activeElement === target;
}

export function useAuthoringEditor<Source extends object | null>({
  formId,
  initialMeta,
  fieldOrder,
  source,
  onReset,
  externalBusy = false,
}: {
  formId: string;
  initialMeta: ItemMeta | null;
  /** The fields the form renders, in order (the focus goes to the first refused one). */
  fieldOrder: readonly string[];
  /** The page's `editable` (null on a create): after a reload, the form resets to it. */
  source: Source;
  /** Resets the form's values to `source` (after Reload and after Discard). */
  onReset: (source: Source) => void;
  /**
   * A step the form runs itself before its action (a file upload): the
   * form is busy, and a failure's focus waits until the step has ended
   * (its controls are disabled while it runs).
   */
  externalBusy?: boolean;
}) {
  const router = useRouter();
  const [meta, setMeta] = useState<ItemMeta | null>(initialMeta);
  const [isPending, startTransition] = useTransition();
  const [running, setRunning] = useState<EditorIntent | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, ManageErrorCode>>({});
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  // A new failure moves the focus once: to `field`, or to the alert.
  const [focusRequest, setFocusRequest] = useState<{ field: string | null } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  // The control that started the last action (the focus target when the
  // conflict dialog closes: Radix returns the focus only to a trigger).
  const invokerRef = useRef<HTMLElement | null>(null);

  // Reload and Discard: re-render the page, then reset the form to the
  // fresh `editable` in the render that brings it (state derived from the
  // `source` prop, React's pattern for a reset; the transition render of
  // the refresh is the first one with the new props and refreshing false).
  const [refreshing, startRefresh] = useTransition();
  const [resetPending, setResetPending] = useState(false);
  const [seenSource, setSeenSource] = useState(source);
  if (source !== seenSource) {
    setSeenSource(source);
    if (resetPending && !refreshing) {
      setResetPending(false);
      if (source && "version" in source) setMeta(metaOf(source as unknown as ItemMeta));
      onReset(source);
    }
  }
  const requestReset = useCallback(() => {
    setResetPending(true);
    startRefresh(() => router.refresh());
  }, [router]);

  // Focus after a failure: the first refused field, else the alert. Once
  // the action has settled: the controls are disabled while it runs, and a
  // disabled control cannot take the focus (a state update after the
  // action's await commits before the transition ends).
  const busy = isPending || refreshing || externalBusy;
  const focused = useRef<object | null>(null);
  useEffect(() => {
    if (!focusRequest || busy || focused.current === focusRequest) return;
    focused.current = focusRequest;
    if (focusRequest.field && focusField(formId, focusRequest.field)) return;
    alertRef.current?.focus();
  }, [focusRequest, busy, formId]);

  /** The first of `fields` in the form's order, or null. */
  const firstField = useCallback(
    (fields: Record<string, ManageErrorCode>) =>
      fieldOrder.find((field) => field in fields) ?? null,
    [fieldOrder],
  );

  const run = useCallback(
    (
      intent: EditorIntent,
      call: ActionCall,
      options: RunOptions = {},
      versionOverride?: string,
    ): void => {
      setFieldErrors({});
      setFailure(null);
      setConflict(null);
      setRunning(intent);
      // The control that started it, unless that is a dialog's own button
      // (a confirmation, Overwrite): those unmount, and the bar button that
      // opened the confirmation was recorded on its click (PublishBar).
      const active = typeof document === "undefined" ? null : document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !active.closest('[role="dialog"]')
      ) {
        invokerRef.current = active;
      }
      startCmsAction(startTransition, {
        action: () => call(versionOverride ?? meta?.version),
        onSuccess: async (data) => {
          if (data) setMeta((previous) => mergeMeta(previous, data));
          await options.onSuccess?.(data ?? null);
        },
        onFailure: (code, result) => {
          if (code === "conflict") {
            setConflict({ version: result.version ?? null, intent, call, options });
            return;
          }
          if (code === "invalid" && result.fields) {
            const sorted = sortFieldErrors(result.fields, new Set(fieldOrder));
            setFieldErrors(sorted.fields);
            setFailure(
              sorted.form
                ? { kind: "code", code: sorted.form }
                : sorted.unshown
                  ? { kind: "common", code: "unshown" }
                  : { kind: "common", code: "invalid" },
            );
            setFocusRequest({ field: sorted.form ? null : firstField(sorted.fields) });
          } else {
            setFailure({ kind: "common", code });
            setFocusRequest({ field: null });
          }
          options.onFailure?.(result.fields ?? {});
        },
        onSettled: () => setRunning(null),
      });
    },
    [meta?.version, fieldOrder, firstField],
  );

  /** A local refusal before any request (a check the form runs itself). */
  const refuse = useCallback(
    (fields: Record<string, ManageErrorCode>) => {
      setFieldErrors(fields);
      setFailure({ kind: "common", code: "invalid" });
      setFocusRequest({ field: firstField(fields) });
    },
    [firstField],
  );

  /**
   * A failure of a step the form ran itself before its save (the upload of
   * a file): the alert above the actions, which takes the focus.
   */
  const fail = useCallback((code: CommonCode | "unshown") => {
    setFieldErrors({});
    setFailure({ kind: "common", code });
    setFocusRequest({ field: null });
  }, []);

  /**
   * "Overwrite" in the conflict dialog: the same call with the cms's
   * current version. The call sends only the fields this form changed, so
   * the other author's changes to the rest stay; afterwards the form
   * reloads the item, so it shows what the cms now holds and its next save
   * starts from that, never from the values it opened with.
   */
  const overwrite = useCallback(() => {
    if (!conflict?.version) return;
    const { options, intent } = conflict;
    // Only a save sent form values; a transition (unpublish, close now,
    // publish) keeps the form's unsaved edits as it would without a conflict.
    const save = SAVE_INTENTS.includes(intent);
    run(
      intent,
      conflict.call,
      {
        ...options,
        onSuccess: async (data) => {
          await options.onSuccess?.(data);
          if (data && save) requestReset();
        },
      },
      conflict.version,
    );
  }, [conflict, run, requestReset]);

  /** Records the control that opens a confirmation (the conflict dialog's focus target). */
  const rememberInvoker = useCallback((element: HTMLElement) => {
    invokerRef.current = element;
  }, []);

  return {
    meta,
    setMeta,
    overwrite,
    invokerRef,
    rememberInvoker,
    pending: busy,
    running,
    fieldErrors,
    failure,
    conflict,
    alertRef,
    run,
    refuse,
    fail,
    clearConflict: () => setConflict(null),
    requestReset,
  };
}

export type AuthoringEditorState = ReturnType<typeof useAuthoringEditor>;
