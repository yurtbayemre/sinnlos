"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, HelpCircle, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { rsvpToEvent } from "@/lib/event-actions";
import type { EventRsvpSummary, RsvpStatus } from "@/lib/types";

/**
 * Yes/no/maybe buttons + attendee summary for one event card. Optimistic
 * via useOptimistic (issue #34): counts and own status flip instantly,
 * the action's refresh() delivers the authoritative summary prop within
 * the same transition, and a rejected action (capacity race, event
 * unpublished meanwhile, …) rolls back automatically — the error is
 * surfaced and router.refresh() re-syncs server state.
 *
 * Privacy shape (per research decision): "yes" responders are listed by
 * name, maybe/no appear only as counts.
 */
export function EventRsvpPanel({
  eventDocumentId,
  capacity,
  selfName,
  summary,
}: {
  eventDocumentId: string;
  capacity: number | null;
  /** Session display name, used to optimistically patch the yes list. */
  selfName: string | null;
  summary: EventRsvpSummary;
}) {
  const t = useTranslations("events");
  const router = useRouter();
  const [error, setError] = useState<"full" | "failed" | null>(null);
  const [isPending, startTransition] = useTransition();

  const applyRsvp = (prev: EventRsvpSummary, status: RsvpStatus): EventRsvpSummary => {
    const next = { ...prev, yesNames: [...prev.yesNames], myStatus: status };
    // Remove the old answer from its bucket …
    if (prev.myStatus === "yes") {
      next.yesCount -= 1;
      if (selfName) {
        const idx = next.yesNames.indexOf(selfName);
        if (idx >= 0) next.yesNames.splice(idx, 1);
      }
    } else if (prev.myStatus === "maybe") next.maybeCount -= 1;
    else if (prev.myStatus === "no") next.noCount -= 1;
    // … and add the new one.
    if (status === "yes") {
      next.yesCount += 1;
      if (selfName) next.yesNames.push(selfName);
    } else if (status === "maybe") next.maybeCount += 1;
    else next.noCount += 1;
    return next;
  };

  const [local, applyOptimistic] = useOptimistic(summary, applyRsvp);
  const isFull = capacity != null && local.yesCount >= capacity;

  const respond = (status: RsvpStatus) => {
    if (isPending || local.myStatus === status) return;
    setError(null);
    startTransition(async () => {
      applyOptimistic(status);
      const result = await rsvpToEvent(eventDocumentId, status);
      if (result.error) {
        setError(result.error);
        router.refresh();
      }
    });
  };

  const options: Array<{ status: RsvpStatus; label: string; icon: typeof Check }> = [
    { status: "yes", label: t("rsvpYes"), icon: Check },
    { status: "maybe", label: t("rsvpMaybe"), icon: HelpCircle },
    { status: "no", label: t("rsvpNo"), icon: X },
  ];

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("rsvpLabel")}>
        {options.map(({ status, label, icon: Icon }) => {
          const selected = local.myStatus === status;
          const blocked = status === "yes" && isFull && !selected;
          return (
            <button
              key={status}
              type="button"
              onClick={() => respond(status)}
              disabled={isPending || blocked}
              aria-pressed={selected}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selected ? "border-primary/40 bg-primary/10 text-primary" : "hover:bg-muted",
                (isPending || blocked) && "opacity-50",
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </button>
          );
        })}
        {isFull && (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            {t("eventFull")}
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error === "full" ? t("rsvpFull") : t("rsvpFailed")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" aria-hidden="true" />
          {capacity != null
            ? t("capacityStatus", { yes: local.yesCount, capacity })
            : t("goingCount", { count: local.yesCount })}
        </span>
        {local.maybeCount > 0 && <span>{t("maybeCount", { count: local.maybeCount })}</span>}
        {local.noCount > 0 && <span>{t("declinedCount", { count: local.noCount })}</span>}
      </div>

      {local.yesNames.length > 0 ? (
        <p className="text-xs text-muted-foreground">{local.yesNames.join(", ")}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("noRsvps")}</p>
      )}
    </div>
  );
}
