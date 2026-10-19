"use client";

import { useRef, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * The web's modal dialog (UI07), on Radix Dialog. It replaces the
 * hand-rolled role=dialog overlays of DeleteClassified and GiveKudos, which
 * announced aria-modal without making the page inert and let Tab walk out
 * of the dialog. Radix brings:
 *   - a focus trap (Tab cycles inside), the rest of the page hidden from
 *     assistive technology and not scrollable while open;
 *   - Escape and a click on the backdrop close it;
 *   - focus back on the trigger when it closes;
 *   - the Title and Description wired as the dialog's name and
 *     description.
 * Portaled to <body>: ancestors with backdrop-filter or a persistent
 * transform (the topbar, PageFade) become the containing block of `fixed`
 * descendants, and the overlay would not cover the viewport inside them.
 * The content sits inside the overlay (Radix's scrollable-overlay layout),
 * so a tall dialog scrolls on a short screen.
 */
export function ModalDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  initialFocus,
  returnFocus,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens the dialog; focus returns to it on close. */
  trigger?: ReactNode;
  title: ReactNode;
  /** Shown under the title and read as the dialog's description. */
  description?: ReactNode;
  /**
   * The element to focus when the dialog opens. Default: an element with
   * autoFocus, else the first focusable one (the close button).
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Where the focus goes when the dialog closes, for a dialog opened
   * without a `trigger` (programmatically, e.g. after a failed save):
   * Radix returns the focus only to its own trigger, and without one it
   * would land on <body>. Ignored while the element is gone.
   */
  returnFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children?: ReactNode;
}) {
  const tCommon = useTranslations("common");
  const hasDescription = description !== undefined && description !== null;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center overflow-y-auto bg-background/60 p-4 backdrop-blur-xs">
          <Dialog.Content
            // Without a Description the dialog has no description at all
            // (Radix would point aria-describedby at a missing element and
            // warn about it).
            {...(hasDescription ? {} : { "aria-describedby": undefined })}
            onCloseAutoFocus={
              returnFocus
                ? (event) => {
                    const target = returnFocus.current;
                    if (target && target.isConnected) {
                      event.preventDefault();
                      target.focus();
                    }
                  }
                : undefined
            }
            onOpenAutoFocus={
              initialFocus
                ? (event) => {
                    event.preventDefault();
                    initialFocus.current?.focus();
                  }
                : undefined
            }
            className={cn(
              "w-full max-w-md animate-scale-in rounded-2xl border bg-background p-6 shadow-2xl outline-hidden",
              className,
            )}
          >
            <div className="flex items-center justify-between gap-4">
              <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={tCommon("close")}
                  className="rounded-lg p-1 outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            {hasDescription && (
              <Dialog.Description className="mt-3 text-sm text-muted-foreground">
                {description}
              </Dialog.Description>
            )}
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The confirm button's look: a destructive red, or the primary colour. */
export type ConfirmTone = "default" | "destructive";

export const CONFIRM_TONE_CLASS: Readonly<Record<ConfirmTone, string>> = {
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
};

/**
 * A yes/no question on {@link ModalDialog}: Cancel (focused first, the safe
 * choice; it closes the dialog) and a confirm button that shows
 * `pendingLabel` and is disabled while `pending`. `error` is shown as an
 * alert above the buttons and the dialog stays open; closing it is the
 * caller's decision (a successful action usually navigates away).
 *
 * `tone` (batch 15, decision 06 §L5; additive): "destructive" (the
 * default, so the existing callers are unchanged) for delete and discard,
 * "default" for a question that destroys nothing (publish, unpublish,
 * overwrite). An async confirmation is the caller's `pending`: onConfirm
 * starts the work (a transition) and the caller passes its pending state
 * back.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  confirmIcon,
  pending = false,
  error,
  tone = "destructive",
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  pendingLabel?: ReactNode;
  /** Decorative icon before the confirm label. */
  confirmIcon?: ReactNode;
  pending?: boolean;
  /** The failure text of the last attempt, or null. */
  error?: ReactNode;
  /** The confirm button's look (default: destructive). */
  tone?: ConfirmTone;
  onConfirm: () => void;
  /** Shown between the description and the buttons (a field, a note). */
  children?: ReactNode;
}) {
  const tCommon = useTranslations("common");
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      title={title}
      description={description}
      initialFocus={cancelRef}
    >
      {children}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-3">
        <Dialog.Close asChild>
          <button
            ref={cancelRef}
            type="button"
            className="rounded-xl border px-4 py-2 text-sm outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {tCommon("cancel")}
          </button>
        </Dialog.Close>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          data-tone={tone}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50",
            CONFIRM_TONE_CLASS[tone],
          )}
        >
          {confirmIcon}
          {pending && pendingLabel !== undefined ? pendingLabel : confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}
