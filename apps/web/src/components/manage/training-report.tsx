import { useTranslations } from "next-intl";
import type { CourseValidityStatus, TrainingReportCounts } from "@sinnlos/domain";
import { Badge } from "@/components/manage/status-badges";

/**
 * The status pieces of the named training report (v0.20), server components
 * (next-intl's hook works there): the status badge of one person and the
 * counts of one course. Text, never colour alone.
 */

const TONE = {
  done: "success",
  dueSoon: "warning",
  expired: "danger",
  open: "neutral",
} as const;

const LABEL = {
  done: "statusDone",
  dueSoon: "statusDueSoon",
  expired: "statusExpired",
  open: "statusOpen",
} as const;

/** The report's statuses, the ones to act on first. */
export const REPORT_STATUSES: readonly CourseValidityStatus[] = [
  "expired",
  "open",
  "dueSoon",
  "done",
];

export function ReportStatusBadge({ status }: { status: CourseValidityStatus }) {
  const t = useTranslations("trainingReport");
  return <Badge tone={TONE[status]}>{t(LABEL[status])}</Badge>;
}

/** "12 of 40 valid" and a badge per status with people in it. */
export function ReportCounts({ counts }: { counts: TrainingReportCounts }) {
  const t = useTranslations("trainingReport");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">
        {t("validOf", { valid: counts.done + counts.dueSoon, total: counts.total })}
      </span>
      {REPORT_STATUSES.filter((status) => counts[status] > 0).map((status) => (
        <Badge key={status} tone={TONE[status]}>
          {t(LABEL[status])}: {counts[status]}
        </Badge>
      ))}
    </div>
  );
}
