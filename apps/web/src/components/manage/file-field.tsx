"use client";

import type { ChangeEvent, ReactNode } from "react";
import { Download, FileText, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { DOCUMENT_UPLOAD_ACCEPT, type EditableMedia } from "@sinnlos/domain";
import { buttonVariants } from "@/components/ui/button";
import { mediaUrl } from "@/lib/config";
import { formatBytes, formatKilobytes, IMAGE_UPLOAD_ACCEPT } from "@/lib/manage/upload-check";
import { cn } from "@/lib/utils";
import { FieldGroup } from "./form-controls";

/**
 * The file input of a document (deep-dive decision 06 §L6 step 1; batch
 * 16 plan, lane 16C item 2): the file the document links now, the choice
 * of a new one ("Choose a file", or "Replace the file" when one exists),
 * and what happens on save. The pick is only kept here; the editor uploads
 * it when the author saves (lib/manage/upload.ts) and then sends its id.
 *
 * The native input is visually hidden but stays in the tab order with its
 * own label (the visible button-like text), so the keyboard opens the
 * browser's dialog with Enter or Space and a screen reader announces the
 * label, the hint and the error (aria-describedby). It carries the field's
 * id (fieldInputId), so a refused file moves the focus to it; its label
 * shows the focus ring. `accept` is the domain's list (K11); the editor
 * checks the size per type before keeping a pick (upload-check.ts).
 */
export function FileField({
  id,
  label,
  hint,
  error,
  current,
  uploadedForSave,
  picked,
  disabled = false,
  uploading = false,
  onPick,
  onCancelPick,
  imageOnly = false,
  onRemove,
}: {
  /** fieldInputId(form, "file"): the input's id. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** The file the form will send (the stored one, one uploaded for this save, or none). */
  current: EditableMedia | null;
  /** `current` was uploaded by this form and is not saved with the document yet. */
  uploadedForSave: boolean;
  /** A file the author picked; uploaded on save. */
  picked: File | null;
  disabled?: boolean;
  /** The picked file is being uploaded. */
  uploading?: boolean;
  onPick: (file: File) => void;
  onCancelPick: () => void;
  imageOnly?: boolean;
  onRemove?: () => void;
}) {
  const t = useTranslations("manage.documents.fields.file");
  const tDocuments = useTranslations("manage.documents");
  const tCommon = useTranslations("manage.common");
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared, so choosing the same file again fires a change too.
    event.target.value = "";
    if (file) onPick(file);
  };
  const href = current && !uploadedForSave ? mediaUrl(current.url) : null;

  return (
    <FieldGroup id={id} legend={label} hint={hint} error={error}>
      {current ? (
        <div className="flex min-w-0 items-center gap-3 rounded-xl border bg-muted/40 px-3 py-2">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">
              {uploadedForSave
                ? t("uploaded", { name: current.name, size: formatKilobytes(current.size) })
                : t("current")}
            </div>
            {!uploadedForSave && (
              <div className="wrap-break-word text-sm font-medium">
                {current.name}
                {current.size > 0 && (
                  <span className="ml-2 font-normal text-muted-foreground">
                    {formatKilobytes(current.size)}
                  </span>
                )}
              </div>
            )}
          </div>
          {href && (
            <a
              href={href}
              download
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "shrink-0")}
              aria-label={t("download", { name: current.name })}
              title={t("download", { name: current.name })}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
            </a>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      )}

      {picked && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 wrap-break-word">
            {t("picked", { name: picked.name, size: formatBytes(picked.size) })}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={onCancelPick}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            {current ? t("cancelPick") : t("cancelPickNew")}
          </button>
        </div>
      )}

      <div>
        <input
          id={id}
          type="file"
          accept={imageOnly ? IMAGE_UPLOAD_ACCEPT : DOCUMENT_UPLOAD_ACCEPT}
          disabled={disabled}
          onChange={onChange}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          className="peer sr-only"
        />
        <label
          htmlFor={id}
          className={cn(
            buttonVariants({ variant: "outline" }),
            "cursor-pointer peer-focus:ring-2 peer-focus:ring-ring peer-focus:ring-offset-2 peer-focus:ring-offset-background peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
          )}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          {current || picked ? t("replace") : t("choose")}
        </label>
      </div>
      {onRemove && (current || picked) && (
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <X className="h-4 w-4" aria-hidden="true" />
          {tCommon("actions.removeImage")}
        </button>
      )}
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {uploading ? tDocuments("uploading") : ""}
      </p>
    </FieldGroup>
  );
}
