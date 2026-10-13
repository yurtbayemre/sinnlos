"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

/** Plain comparison of two values objects (strings, booleans, lists). */
export function sameValues(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  const dirty = !sameValues(values, initial);

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
    [values, meta, initial, retarget, extraInput, run, actions, flash, t, router, area],
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
      schedule: () => setScheduleOpen(true),
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
    /** Reload after a conflict: the fresh `editable`, the changes dropped. */
    reload: () => {
      editor.clearConflict();
      requestReset();
    },
  };
}
