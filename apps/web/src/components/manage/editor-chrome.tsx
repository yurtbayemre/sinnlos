"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, ClipboardCopy, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { ModalDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { formatInstant, type DateTimeFields } from "@/lib/date-format";
import type { ManageArea } from "@/lib/manage/areas";
import { cn } from "@/lib/utils";
import { StatusBadges, Badge } from "./status-badges";
import type { ConflictState, FormFailure, ItemMeta } from "./use-authoring-editor";
import { useFieldErrorText } from "./error-text";

/**
 * The parts every /manage editor shares (deep-dive decision 06 §L4): the
 * status line, the failure alert, the action bar, the conflict dialog.
 */

const DATE_TIME: DateTimeFields = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

/** The scheduler's failure codes with a text of their own (§D rule 5, 7). */
const SCHEDULE_ERROR_TEXTS = ["windowExpired", "notPublishable", "retryExhausted"] as const;

/**
 * The item's status: its badges and, in words, when it publishes or
 * withdraws, since when it is published and why a schedule failed.
 */
export function EditorStatus({
  meta,
  dirty,
  needsRetarget,
  ownerDepartment,
  showOwner,
  hideStatus = false,
}: {
  meta: ItemMeta | null;
  dirty: boolean;
  needsRetarget?: boolean;
  ownerDepartment?: { documentId: string; name: string } | null;
  showOwner: boolean;
  hideStatus?: boolean;
}) {
  const t = useTranslations("manage.common");
  const format = useFormatter();
  if (!meta) {
    return dirty ? (
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="warning">{t("status.unsaved")}</Badge>
      </div>
    ) : null;
  }
  const publishAt = formatInstant(format, meta.publishAt, DATE_TIME);
  const unpublishAt = formatInstant(format, meta.unpublishAt, DATE_TIME);
  const publishedAt = formatInstant(format, meta.publishedAt, DATE_TIME);
  const reason = meta.scheduleError
    ? (SCHEDULE_ERROR_TEXTS as readonly string[]).includes(meta.scheduleError)
      ? t(`scheduleErrors.${meta.scheduleError as (typeof SCHEDULE_ERROR_TEXTS)[number]}`)
      : t("scheduleErrors.other", { code: meta.scheduleError })
    : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadges
          item={{ ...meta, needsRetarget, ownerDepartment }}
          showOwner={showOwner}
          hideStatus={hideStatus}
        />
        {dirty && <Badge tone="warning">{t("status.unsaved")}</Badge>}
      </div>
      <ul className="space-y-0.5 text-sm text-muted-foreground">
        {/* The publication state in words (batch 16.1, issue #80): an item
            without a published version (never published, unpublished, or
            withdrawn by its schedule) is not shown to readers, and saved
            changes of a published item wait for Publish. The badge alone
            did not say so. Nothing here promises who reads the published
            version: an expired announcement, for one, stays published and
            is hidden all the same (Codex review). */}
        {meta.status === "draft" && !hideStatus && <li>{t("detail.notPublished")}</li>}
        {meta.status === "modified" && !hideStatus && <li>{t("detail.changesPending")}</li>}
        {publishedAt && !hideStatus && <li>{t("detail.publishedOn", { date: publishedAt })}</li>}
        {publishAt && !meta.scheduleError && (
          <li>{t("detail.publishesOn", { date: publishAt })}</li>
        )}
        {unpublishAt && <li>{t("detail.withdrawsOn", { date: unpublishAt })}</li>}
        {reason && <li className="text-destructive">{t("detail.scheduleFailed", { reason })}</li>}
      </ul>
    </div>
  );
}

/** The failure of the last action, above the actions; it takes the focus. */
export function FormAlert({
  area,
  scope,
  failure,
  alertRef,
}: {
  area: ManageArea;
  /** The form's own field texts (useFieldErrorText). */
  scope?: string;
  failure: FormFailure | null;
  alertRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslations("manage.common.failure");
  const fieldText = useFieldErrorText(area, scope);
  if (!failure) return null;
  const text = failure.kind === "code" ? fieldText("_form", failure.code) : t(failure.code);
  return (
    <div
      ref={alertRef}
      role="alert"
      tabIndex={-1}
      className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

/** The bar of an editor's actions: sticky at the bottom of the viewport from md on. */
export function ActionBar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2 border-t bg-background/95 py-4 backdrop-blur md:sticky md:bottom-0 md:z-10"
    >
      {children}
    </div>
  );
}

/**
 * The 412 dialog (§L4): "Someone changed this item after you opened it,
 * possibly in the Strapi admin panel." Reload (the changes are lost; Copy
 * keeps the text) or Overwrite with the cms's current version, an explicit
 * choice. Without a current version there is nothing to overwrite with.
 */
export function ConflictDialog({
  conflict,
  copyText,
  pending,
  onReload,
  onOverwrite,
  onClose,
  returnFocus,
}: {
  conflict: ConflictState | null;
  /** The text the author typed (title and body), for the copy button. */
  copyText: string;
  pending: boolean;
  onReload: () => void;
  /** Repeats the refused action with the cms's current version. */
  onOverwrite: () => void;
  onClose: () => void;
  /** The control that started the refused action: the focus goes back to it. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("manage.common.conflict");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const reloadRef = useRef<HTMLButtonElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <ModalDialog
      open={conflict !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopyState("idle");
          onClose();
        }
      }}
      title={t("title")}
      description={t("body")}
      initialFocus={reloadRef}
      returnFocus={returnFocus}
    >
      <div className="mt-4 space-y-4 text-sm">
        <div className="space-y-2">
          <p className="text-muted-foreground">{t("reloadHint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={reloadRef}
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setCopyState("idle");
                onReload();
              }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("reload")}
            </Button>
            <Button type="button" variant="ghost" onClick={copy} disabled={copyText === ""}>
              <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
              {t("copy")}
            </Button>
          </div>
          <p aria-live="polite" className={cn(copyState === "failed" && "text-destructive")}>
            {copyState === "copied" ? t("copied") : copyState === "failed" ? t("copyFailed") : ""}
          </p>
        </div>
        {conflict?.version ? (
          <div className="space-y-2 border-t pt-4">
            <p className="text-muted-foreground">{t("overwriteHint")}</p>
            <Button type="button" variant="destructive" disabled={pending} onClick={onOverwrite}>
              {t("overwrite")}
            </Button>
          </div>
        ) : null}
        <div className="flex justify-end">
          <Dialog.Close asChild>
            <Button type="button" variant="ghost">
              {/* "Cancel" keeps the form as it is. */}
              <CancelLabel />
            </Button>
          </Dialog.Close>
        </div>
      </div>
    </ModalDialog>
  );
}

function CancelLabel() {
  const t = useTranslations("common");
  return <>{t("cancel")}</>;
}

/** The error text under a field, from the editor's field errors. */
export function useFieldError(
  area: ManageArea,
  fieldErrors: Readonly<Record<string, string>>,
  scope?: string,
) {
  const text = useFieldErrorText(area, scope);
  return (field: string): string | undefined => {
    const code = fieldErrors[field];
    return code ? text(field, code) : undefined;
  };
}
