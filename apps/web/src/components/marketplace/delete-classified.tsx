"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { isSharedErrorCode, startCmsAction, type CommonCode } from "@/lib/action-result";
import { deleteClassified } from "@/lib/classified-actions";

/**
 * Delete button with a confirmation dialog (UI07: the shared ConfirmDialog
 * on Radix Dialog — focus trap, Escape, focus back on the button, Cancel
 * focused first). A successful delete redirects server-side to
 * /marketplace (startCmsAction rethrows that redirect); a refused or
 * failed one answers a code (AC01) and the dialog stays open with its
 * text. Opening the dialog again starts without the old error.
 */
export function DeleteClassified({ id, title }: { id: number; title: string }) {
  const t = useTranslations("marketplace");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("actionErrors");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<CommonCode | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleOpenChange = (next: boolean) => {
    if (next) setError(null);
    setOpen(next);
  };

  const confirmDelete = () => {
    setError(null);
    startCmsAction(startTransition, {
      action: () => deleteClassified(id),
      onFailure: setError,
    });
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-xl border border-destructive/40 px-4 py-2.5 text-sm font-medium text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {t("deleteAd")}
        </button>
      }
      title={t("deleteConfirmTitle")}
      description={t("deleteConfirmBody", { title })}
      confirmLabel={tCommon("delete")}
      pendingLabel={t("deleting")}
      confirmIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
      pending={isPending}
      error={error && (isSharedErrorCode(error) ? tErrors(error) : t("deleteFailed"))}
      onConfirm={confirmDelete}
    />
  );
}
