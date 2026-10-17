import { useFormatter, useTranslations } from "next-intl";
import type { AuthoringDocumentStatus, OwnerDepartment } from "@sinnlos/domain";
import { formatInstant, type DateTimeFields } from "@/lib/date-format";
import { cn } from "@/lib/utils";

/**
 * The status badges of /manage (deep-dive decision 06 §L4, §N9): Draft,
 * Published or Changes pending; Scheduled; Schedule failed; for moderators
 * the owner Department; Needs re-targeting for moderators and for
 * department authors on their own items. Text, never colour alone. Used in
 * the lists (server) and the editors (client): no "use client", and
 * next-intl's hooks work in both.
 */

const DATE_TIME: DateTimeFields = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

const TONE = {
  neutral: "border-border bg-muted/60 text-foreground",
  success: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  info: "border-sky-600/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warning: "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

export function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

export interface StatusBadgeInput {
  status?: AuthoringDocumentStatus;
  publishAt?: string | null;
  scheduleError?: string | null;
  ownerDepartment?: OwnerDepartment | null;
  needsRetarget?: boolean;
}

/**
 * `showOwner`: the Department badge (moderators; a department author's
 * items are all their department's). `hideStatus`: polls, which are always
 * published.
 */
export function StatusBadges({
  item,
  showOwner = false,
  hideStatus = false,
  className,
}: {
  item: StatusBadgeInput;
  showOwner?: boolean;
  hideStatus?: boolean;
  className?: string;
}) {
  const t = useTranslations("manage.common.status");
  const format = useFormatter();
  const publishAt = formatInstant(format, item.publishAt, DATE_TIME);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {!hideStatus && item.status && (
        <Badge
          tone={
            item.status === "published"
              ? "success"
              : item.status === "modified"
                ? "info"
                : "neutral"
          }
        >
          {t(item.status)}
        </Badge>
      )}
      {publishAt && !item.scheduleError && (
        <Badge tone="info">
          {t("scheduled")}: {publishAt}
        </Badge>
      )}
      {item.scheduleError && <Badge tone="danger">{t("scheduleFailed")}</Badge>}
      {showOwner && item.ownerDepartment && (
        <Badge tone="neutral">{t("department", { name: item.ownerDepartment.name })}</Badge>
      )}
      {item.needsRetarget && <Badge tone="warning">{t("needsRetarget")}</Badge>}
    </div>
  );
}
