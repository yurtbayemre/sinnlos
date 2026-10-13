"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { AuthoringResult, EditableBase } from "@sinnlos/domain";
import type { AuthoringActionResult } from "@/lib/manage/authoring-action";
import { AREA_PATH, areaItemPath, hasDrafts, type ManageArea } from "@/lib/manage/areas";
import type { SaveInput } from "@/lib/manage/save";
import type { ScheduleValues } from "@/lib/manage/values";
import { useManageFlash } from "./flash";
import type { PublishBarHandlers } from "./publish-bar";
import { metaOf, useAuthoringEditor, type ItemMeta } from "./use-authoring-editor";

/**
 * One /manage editor's values and actions (deep-dive decision 06 §L3, §L4),
 * on top of useAuthoringEditor: the values the form holds, the values it
 * started from (an update sends only what changed against them, and the
 * Unsaved changes badge compares with them), and the handlers of the
 * publish bar wired to the area's Server Actions.
 *
 *  - A create navigates to the new item's page; a delete (or a discard
 *    that removed a never-published draft) to the list; the message
 *    survives the navigation (ManageFlash).
 *  - A save makes the saved values the new baseline; a discard and a
 *    Reload reset the form to the fresh `editable`.
 *  - Unsaved changes ask before the tab is closed or reloaded.
 */

export interface ItemActions {
  save: (input: SaveInput) => Promise<AuthoringActionResult>;
  publish?: (documentId: string, version: string) => Promise<AuthoringActionResult>;
  unpublish?: (documentId: string, version: string) => Promise<AuthoringActionResult>;
  discard?: (documentId: string, version: string) => Promise<AuthoringActionResult>;
  remove: (documentId: string, version: string) => Promise<AuthoringActionResult>;
}

/** Lists whose order means something (a poll's answers: votes point at an index). */
const ORDERED_LISTS = new Set(["options"]);

/**
 * Whether two values objects say the same (strings, booleans, lists). A
 * list of ids is a set (a checkbox list puts its selection in option
 * order); `options` keeps its order.
 */
export function sameValues(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const x = left[key];
    const y = right[key];
    if (Array.isArray(x) && Array.isArray(y) && !ORDERED_LISTS.has(key)) {
      if (x.length !== y.length) return false;
      const sortedX = [...x].map(String).sort();
      const sortedY = [...y].map(String).sort();
      if (sortedX.some((value, i) => value !== sortedY[i])) return false;
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      return false;
    }
  }
  return true;
}

export function useItemEditor<V extends object, E extends EditableBase>({
  area,
  formId,
  editable,
  toValues,
  emptyValues,
  fieldOrder,
  actions,
  extraInput,
}: {
  area: ManageArea;
  formId: string;
  editable: E | null;
  toValues: (editable: E) => V;
  emptyValues: V;
  fieldOrder: readonly string[];
  actions: ItemActions;
  /** More arguments of every save (a poll's hasVotes). */
  extraInput?: Record<string, unknown>;
}) {
  const t = useTranslations("manage.common.success");
  const router = useRouter();
  const flash = useManageFlash();
  const [values, setValues] = useState<V>(() => (editable ? toValues(editable) : emptyValues));
  const [initial, setInitial] = useState<V>(values);
  const [retarget, setRetarget] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const onReset = useCallback(
    (source: E | null) => {
      if (!source) return;
      const fresh = toValues(source);
      setValues(fresh);
      setInitial(fresh);
      setRetarget(false);
    },
    [toValues],
  );

  const editor = useAuthoringEditor({
    formId,
    initialMeta: editable ? metaOf(editable as unknown as ItemMeta) : null,
    fieldOrder,
    source: editable,
    onReset,
  });
  const { meta, run, requestReset } = editor;
  // A ticked re-target confirmation is a change to save: the publish bar
  // then saves (Save and publish) instead of publishing the draft as it is.
  const dirty = retarget || !sameValues(values, initial);
  // The Schedule… button that opened the dialog, for the focus on close.
  const scheduleOpener = useRef<HTMLElement | null>(null);

  // Unsaved changes: ask before the tab closes or reloads.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setValue = useCallback(<K extends keyof V>(key: K, value: V[K]) => {
    setValues((previous) => ({ ...previous, [key]: value }));
  }, []);

  const goToList = useCallback(() => router.push(AREA_PATH[area]), [router, area]);

  /** A save of the current values; `schedule` from the Schedule… dialog. */
  const save = useCallback(
    (status: "draft" | "published", schedule?: ScheduleValues) => {
      const snapshot = values;
      const creating = meta === null;
      // A draft save without a change would write an empty draft, advance
      // the revision (other tabs get 412) and show "Changes pending".
      if (!creating && !schedule && !dirty && (status === "draft" || !hasDrafts(area))) return;
      const intent = schedule
        ? "schedule"
        : creating
          ? status === "published"
            ? "saveAndPublish"
            : "create"
          : status === "published"
            ? "saveAndPublish"
            : "saveDraft";
      run(
        intent,
        (version) =>
          actions.save({
            ...(meta ? { documentId: meta.documentId, version } : {}),
            status,
            values: snapshot,
            initial: meta ? initial : null,
            retarget,
            ...(schedule ? { schedule } : {}),
            ...extraInput,
          }),
        {
          // A refusal that is not about the schedule's own fields (the
          // title, a lost permission, an outage) closes the dialog: the
          // form's errors and alert are behind it.
          onFailure: (fields) => {
            if (!schedule) return;
            const keys = Object.keys(fields);
            if (
              keys.length === 0 ||
              keys.some((key) => key !== "publishAt" && key !== "unpublishAt")
            ) {
              // The focus goes to the refused field, not back to Schedule….
              scheduleOpener.current = null;
              setScheduleOpen(false);
            }
          },
          onSuccess: (data: AuthoringResult | null) => {
            if (schedule) setScheduleOpen(false);
            if (creating && data) {
              flash(status === "published" ? t("createdPublished") : t("created"));
              router.replace(areaItemPath(area, data.documentId));
              return;
            }
            setInitial(snapshot);
            setRetarget(false);
            flash(
              schedule
                ? t("scheduled")
                : !hasDrafts(area)
                  ? t("saved")
                  : status === "published"
                    ? t("published")
                    : t("draftSaved"),
            );
          },
        },
      );
    },
    [values, meta, initial, retarget, dirty, extraInput, run, actions, flash, t, router, area],
  );

  const transition = useCallback(
    (
      intent: "publish" | "unpublish" | "discard" | "delete",
      action: ((documentId: string, version: string) => Promise<AuthoringActionResult>) | undefined,
    ) => {
      if (!meta || !action) return;
      const documentId = meta.documentId;
      run(intent, (version) => action(documentId, version ?? ""), {
        onSuccess: (data) => {
          if (intent === "delete" || (intent === "discard" && data === null)) {
            flash(t("deleted"));
            goToList();
            return;
          }
          if (intent === "discard") {
            flash(t("discarded"));
            requestReset();
            return;
          }
          flash(intent === "publish" ? t("published") : t("unpublished"));
        },
      });
    },
    [meta, run, flash, t, goToList, requestReset],
  );

  const handlers: PublishBarHandlers = useMemo(
    () => ({
      saveDraft: () => save("draft"),
      saveAndPublish: () => save("published"),
      publish: () => transition("publish", actions.publish),
      unpublish: () => transition("unpublish", actions.unpublish),
      discard: () => transition("discard", actions.discard),
      delete: () => transition("delete", actions.remove),
      schedule: () => {
        const active = document.activeElement;
        scheduleOpener.current = active instanceof HTMLElement ? active : null;
        setScheduleOpen(true);
      },
    }),
    [save, transition, actions],
  );

  /** Apply a change the cms already holds (a poll closed now) to the values and the baseline. */
  const rebase = useCallback((patch: Partial<V>) => {
    setValues((previous) => ({ ...previous, ...patch }));
    setInitial((previous) => ({ ...previous, ...patch }));
  }, []);

  return {
    values,
    setValue,
    setValues,
    rebase,
    initial,
    dirty,
    editor,
    handlers,
    save,
    retarget,
    setRetarget,
    scheduleOpen,
    setScheduleOpen,
    scheduleOpener,
    /**
     * Reload after a conflict: the fresh `editable`, the changes dropped,
     * the Schedule… dialog closed (its values belonged to the old version).
     */
    reload: () => {
      editor.clearConflict();
      setScheduleOpen(false);
      requestReset();
    },
  };
}
