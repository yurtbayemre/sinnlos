import { redirect } from "next/navigation";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock, UserX } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateOnly, LONG_DAY } from "@/lib/date-format";
import { loadAckReport, type AckReportAudience } from "@/lib/loaders/ack-report";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { AdminPageHeader } from "@/components/admin-page-header";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("ackReport");
  return { title: t("title") };
}

/**
 * The acknowledgement report. The reads and the fail-closed rules (the
 * denominator counts the role types holding `announcement.find`, lib/roles.ts
 * ANNOUNCEMENT_READER_ROLES; an indeterminable audience is "–", never a
 * green 0 of 0) are lib/loaders/ack-report.ts (WD03); the page renders.
 */
export default async function AcknowledgementReportPage() {
  if (!capabilitiesFor((await getViewer()).role).reports.acknowledgements) {
    redirect("/");
  }

  const [t, locale, view] = await Promise.all([
    getTranslations("ackReport"),
    getLocale(),
    loadAckReport(),
  ]);

  // ackDeadline is a calendar date: shown as that day, never moved by a zone.
  const deadlineLabel = (date: string | null) => formatDateOnly(locale, date, LONG_DAY);

  /**
   * One chip per targeting criterion the announcement sets — an
   * announcement scoped to a team or to roles must not read "all
   * employees". No criterion set = company-wide.
   */
  const audienceLabels = (audience: AckReportAudience): string[] => {
    const parts: string[] = [];
    if (audience.department !== null) {
      parts.push(t("audienceDepartment", { name: audience.department }));
    }
    if (audience.team !== null) parts.push(t("audienceTeam", { name: audience.team }));
    if (audience.roles.length > 0) {
      parts.push(t("audienceRoles", { names: audience.roles.join(", ") }));
    }
    return parts.length > 0 ? parts : [t("audienceAll")];
  };

  return (
    <div className="space-y-8">
      <AdminPageHeader title={t("title")} description={t("description")} />

      {view.failed && <FetchErrorBanner />}

      {/* Fail-closed: a truncated input walk makes the numbers below too
          low, so warn explicitly and never let the report read as a
          complete, green "everyone confirmed" (#14). */}
      {view.truncated && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <div className="font-medium">{t("reportIncompleteTitle")}</div>
            <div className="text-amber-700/90 dark:text-amber-300/90">
              {t("reportIncompleteHint")}
            </div>
          </div>
        </div>
      )}

      {view.empty ? (
        <EmptyState icon={ClipboardCheck} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="space-y-4">
          {view.rows.map((row) => {
            const deadline = deadlineLabel(row.ackDeadline);
            return (
              <Card key={row.id}>
                <CardHeader>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <CardTitle as="h2" className="text-base">
                        {row.title}
                      </CardTitle>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        {audienceLabels(row.audience).map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                        {deadline && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" aria-hidden="true" />
                            {t("deadline", { date: deadline })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* No percentage without a known denominator — an
                          indeterminable audience must not read as 0 of 0. */}
                      <div className="text-2xl font-semibold tracking-tight">
                        {row.targetUnknown ? "–" : `${row.pct}%`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {row.targetUnknown
                          ? t("audienceUnknown")
                          : t("ackedOf", { acked: row.ackedCount, total: row.targetTotal })}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!row.targetUnknown && (
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${row.pct}%` }}
                      />
                    </div>
                  )}
                  {row.targetUnknown ? (
                    <div className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      {/* The headline already sits in the card header; this
                          line explains WHY there is no rate. */}
                      <span>{t("audienceUnknownHint")}</span>
                    </div>
                  ) : row.openUsers.length === 0 ? (
                    <div className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      {t("allAcked")}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="inline-flex items-center gap-1.5 text-sm font-medium">
                        <UserX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        {t("openUsers", { count: row.openUsers.length })}
                      </div>
                      <ul className="flex flex-wrap gap-1.5">
                        {row.openUsers.map((u) => (
                          <li
                            key={u.id}
                            className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {u.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
