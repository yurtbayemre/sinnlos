"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Trash2, X } from "lucide-react";
import { deleteClassified } from "@/lib/classified-actions";

/**
 * Delete button with a confirmation dialog (give-kudos modal pattern:
 * role=dialog, aria-modal, Escape + backdrop close). Navigation happens
 * client-side after the action confirms success — the action itself only
 * deletes and refresh()es.
 */
export function DeleteClassified({ id, title }: { id: number; title: string }) {
  const t = useTranslations("marketplace");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Close the dialog on Escape while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const confirmDelete = () => {
    startTransition(async () => {
      setError(false);
      const result = await deleteClassified(id);
      if (result?.error) {
        setError(true);
        return;
      }
      router.push("/marketplace");
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-xl border border-destructive/40 px-4 py-2.5 text-sm font-medium text-destructive transition hover:bg-destructive/10"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {t("deleteAd")}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
          onMouseDown={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-classified-title"
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-md animate-scale-in rounded-2xl border bg-background p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h2 id="delete-classified-title" className="text-lg font-semibold">
                {t("deleteConfirmTitle")}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={tCommon("close")}
                className="rounded-lg p-1 transition hover:bg-muted"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <p className="mt-3 text-sm text-muted-foreground">
              {t("deleteConfirmBody", { title })}
            </p>

            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {t("deleteFailed")}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-xl border px-4 py-2 text-sm transition hover:bg-muted"
              >
                {tCommon("cancel")}
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={isPending}
                className="inline-flex items-center gap-2 rounded-xl bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {isPending ? t("deleting") : tCommon("delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
