import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import type { CourseValidityStatus } from "@sinnlos/domain";

import { formatDateOnly, SHORT_DAY } from "@/lib/date-format";

type StatusKey =
  | "statusDone"
  | "statusDueSoon"
  | "nextRenewal"
  | "statusExpired"
  | "statusExpiredNoDate"
  | "statusProgress";

/**
 * A course's status for the caller (v0.20): done (with the next renewal day
 * when the course expires), due soon, expired, or the progress. The due day
 * is the first day the completion no longer counts. "–" while the progress
 * could not be read completely (fail closed). Takes the page's `training`
 * translator and locale, so the server pages render it without a client
 * provider.
 */
export function CourseStatus({
  t,
  locale,
  status,
  dueKey,
  completed,
  total,
  unknown,
}: {
  t: (key: StatusKey, values?: Record<string, string | number>) => string;
  locale: string;
  status: CourseValidityStatus;
  dueKey: string | null;
  completed: number;
  total: number;
  unknown: boolean;
}) {
  if (unknown) return <span className="text-muted-foreground">–</span>;
  const date = formatDateOnly(locale, dueKey, SHORT_DAY);
  if (status === "done" || status === "dueSoon") {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {t("statusDone")}
        </span>
        {date &&
          (status === "dueSoon" ? (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {t("statusDueSoon", { date })}
            </span>
          ) : (
            <span className="text-muted-foreground">{t("nextRenewal", { date })}</span>
          ))}
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {date ? t("statusExpired", { date }) : t("statusExpiredNoDate")}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">{t("statusProgress", { done: completed, total })}</span>
  );
}
