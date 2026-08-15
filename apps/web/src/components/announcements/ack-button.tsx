"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { acknowledgeAnnouncement } from "@/lib/acknowledgement-actions";

/**
 * Confirm-read control for mandatory announcements. Date labels are
 * pre-formatted on the server (only serializable props cross the RSC
 * boundary); after a successful action the server-side refresh() delivers
 * the authoritative acknowledged state as new props.
 */
export function AckButton({
  announcementDocumentId,
  acknowledgedAtLabel,
  deadlineLabel,
}: {
  /** Strapi documentId of the announcement (stable across re-publishes). */
  announcementDocumentId: string;
  /** Pre-formatted date of the caller's own ack, or null when unacknowledged. */
  acknowledgedAtLabel: string | null;
  /** Pre-formatted ackDeadline, or null when none is set. */
  deadlineLabel: string | null;
}) {
  const t = useTranslations("announcements");
  const router = useRouter();
  const [justAcked, setJustAcked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const acknowledged = acknowledgedAtLabel !== null || justAcked;

  const handleAck = () => {
    if (acknowledged || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        await acknowledgeAnnouncement(announcementDocumentId);
        setJustAcked(true);
      } catch {
        // Rejected (already acknowledged elsewhere, target changed, …) —
        // surface it and pull the authoritative state from the server.
        setError(t("ackFailed"));
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {acknowledged ? (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {acknowledgedAtLabel
            ? t("ackConfirmedAt", { date: acknowledgedAtLabel })
            : t("ackConfirmed")}
        </span>
      ) : (
        <Button size="sm" onClick={handleAck} disabled={isPending}>
          <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {isPending ? t("ackPending") : t("ackButton")}
        </Button>
      )}
      {!acknowledged && deadlineLabel && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          {t("ackDeadline", { date: deadlineLabel })}
        </span>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
