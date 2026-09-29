import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardCheck, Clock, UserX } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { teamIdsByUser } from "@/lib/audience";
import { formatDateOnly, LONG_DAY } from "@/lib/date-format";
import {
  buildAckReportRows,
  eligibleReportUsers,
  reportCompleteness,
  type ReportAnnouncement,
  type ReportUser,
} from "@/lib/ack-report";
import { isAdmin } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { listAckReportAnnouncements } from "@/lib/api/announcements";
import { fetchAnnouncementAckIndex } from "@/lib/acknowledgements";
import { fetchAllTeams } from "@/lib/teams";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("ackReport");
  return { title: t("title") };
}

/**
 * Role types holding `announcement.find` in the CMS permission matrix
 * (apps/cms/src/index.ts) — only they can ever see, and therefore be
 * expected to confirm, a mandatory announcement. `guest` deliberately has
 * NO announcement read and must not inflate the report's denominator.
 * infra/contracts.test.ts pins this copy against the matrix.
 */
const ANNOUNCEMENT_READER_ROLES = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "authenticated",
]);

export default async function AcknowledgementReportPage() {
  if (!isAdmin((await getViewer()).role)) {
    redirect("/");
  }

  const [t, tAdmin, locale] = await Promise.all([
    getTranslations("ackReport"),
    getTranslations("admin"),
    getLocale(),
  ]);

  // admin_role bypasses both the acknowledgement-visibility and the
  // announcement-visibility policy, so these return EVERY announcement and
  // (below) every user's acks of them — the target audience is recomputed
  // instead of being handed to us by the API. Users come via the paginated
  // directory helper. Like every strapi() read, all are uncached (D-DC01).
  const [announcementsResult, usersResult, teamsResult] = await Promise.all([
    // Every mandatory announcement with its targeting fields, a full page
    // walk (lib/api/announcements.ts listAckReportAnnouncements: the
    // audienceRoles populate needs the role.find grant admin_role holds for
    // exactly this page).
    tryFetch(() => listAckReportAnnouncements(), "ack-report"),
    tryFetch(
      () =>
        // role is populated with the users-permissions role.find grant;
        // blocked is a plain (non-private) users-permissions field.
        fetchAllUsers<ReportUser>(
          "fields[0]=id&fields[1]=username&fields[2]=displayName&fields[3]=email&fields[4]=blocked&populate[department][fields][0]=name&populate[role]=true",
        ),
      "ack-report",
    ),
    // Team membership for team-scoped announcements: `team.lead` has no
    // inverse field on the user, so the mapping can only be built from the
    // team side (lead counts as a member for targeting). `api.teams.list()`
    // is a full page walk too since #26, but fetchAllTeams stays the right
    // fetch here: (a) it field-limits the user populates to username/ids —
    // no contact payload (data minimisation) — and (b) its `truncated`
    // signal is already wired into reportCompleteness below (fail-closed).
    tryFetch(() => fetchAllTeams(), "ack-report"),
  ]);

  // Re-check requiresAck: DEMO_MODE's fixture answers announcement paths
  // unfiltered, and it keeps the report honest if the query ever changes.
  const announcements = (announcementsResult.data?.data ?? []).filter((a) => a.requiresAck);
  // The acks of exactly the listed announcements, fetched per chunk of
  // documentIds with a cap per chunk (FX32; the old global walk stopped at
  // 2000 acks and left the report "incomplete" for good).
  const acksResult = await tryFetch(
    () =>
      fetchAnnouncementAckIndex(
        announcements.map((a) => a.documentId).filter((id): id is string => !!id),
      ),
    "ack-report",
  );
  const acks = acksResult.data?.index ?? new Map<string, Set<number>>();
  const users = usersResult.data?.users ?? [];
  const anyFailed =
    announcementsResult.failed || acksResult.failed || usersResult.failed || teamsResult.failed;

  // Only unblocked users whose role can actually read announcements count
  // toward the report (lib/ack-report.ts).
  const eligibleUsers = eligibleReportUsers(users, ANNOUNCEMENT_READER_ROLES);
  const userTeamIds = teamIdsByUser(teamsResult.data?.teams ?? []);

  /**
   * Fail-closed inputs for the target-audience computation.
   *
   * A missing input must never masquerade as "nobody is targeted": that
   * used to render as 0 of 0 → 100% → a green "everyone confirmed", i.e.
   * the report claimed compliance precisely when it knew the least.
   *   - no user directory  → NO row has a determinable audience.
   *   - no / truncated team roster → only rows with a `team` criterion are
   *     affected; department- and role-scoped rows stay exact.
   *
   * `reportTruncated` additionally covers the announcement and ack walks:
   * either being cut short makes the WHOLE report undercount, so a banner
   * warns that the numbers may be too low and no result reads as complete.
   * `fetchAllUsers` now reports whether its MAX_USERS cap was hit, so a
   * directory of >2000 users no longer silently shrinks the denominator
   * into a false-green rate (#14) — see users.ts.
   */
  const {
    usersUnknown,
    teamsUnknown,
    truncated: reportTruncated,
  } = reportCompleteness({
    usersFailed: usersResult.failed,
    usersTruncated: usersResult.data?.truncated ?? false,
    teamsFailed: teamsResult.failed,
    teamsTruncated: teamsResult.data?.truncated ?? false,
    acksFailed: acksResult.failed,
    acksTruncated: acksResult.data?.truncated ?? false,
    announcementsFailed: announcementsResult.failed,
    announcementsTruncated: announcementsResult.data?.truncated ?? false,
  });

  // ackDeadline is a calendar date: shown as that day, never moved by a zone.
  const deadlineLabel = (a: ReportAnnouncement) => formatDateOnly(locale, a.ackDeadline, LONG_DAY);
  const userName = (u: ReportUser) => u.displayName ?? u.username ?? u.email ?? `#${u.id}`;

  /**
   * One chip per targeting criterion the announcement sets — an
   * announcement scoped to a team or to roles must not read "all
   * employees". No criterion set = company-wide.
   */
  const audienceLabels = (a: ReportAnnouncement): string[] => {
    const parts: string[] = [];
    // No `audience === "departments"` check: a linked department restricts
    // unconditionally (lib/audience.ts), so the chip must show it either
    // way — otherwise the label would read "all employees" for a post the
    // policy scopes to one department.
    if (a.department?.id != null) {
      parts.push(t("audienceDepartment", { name: a.department.name ?? `#${a.department.id}` }));
    }
    if (a.team?.id != null) {
      parts.push(t("audienceTeam", { name: a.team.name ?? `#${a.team.id}` }));
    }
    const roleNames = (a.audienceRoles ?? []).map((r) => r.name ?? r.type ?? `#${r.id}`);
    if (roleNames.length > 0) {
      parts.push(t("audienceRoles", { names: roleNames.join(", ") }));
    }
    return parts.length > 0 ? parts : [t("audienceAll")];
  };

  // A row whose audience cannot be determined is reported as UNKNOWN, never
  // as "everyone confirmed" (lib/ack-report.ts buildAckReportRows).
  const rows = buildAckReportRows({
    announcements,
    acks,
    eligibleUsers,
    userTeamIds,
    usersUnknown,
    teamsUnknown,
  });

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/manage"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {tAdmin("title")}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">{t("description")}</p>
      </div>

      {anyFailed && <FetchErrorBanner />}

      {/* Fail-closed: a truncated input walk makes the numbers below too
          low, so warn explicitly and never let the report read as a
          complete, green "everyone confirmed" (#14). */}
      {reportTruncated && (
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

      {rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="space-y-4">
          {rows.map(
            ({ announcement: a, targetUsers, openUsers, ackedCount, pct, targetUnknown }) => (
              <Card key={a.id}>
                <CardHeader>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-base">{a.title}</CardTitle>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        {audienceLabels(a).map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                        {deadlineLabel(a) && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" aria-hidden="true" />
                            {t("deadline", { date: deadlineLabel(a) ?? "" })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* No percentage without a known denominator — an
                        indeterminable audience must not read as 0 of 0. */}
                      <div className="text-2xl font-semibold tracking-tight">
                        {targetUnknown ? "–" : `${pct}%`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {targetUnknown
                          ? t("audienceUnknown")
                          : t("ackedOf", { acked: ackedCount, total: targetUsers.length })}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!targetUnknown && (
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                  {targetUnknown ? (
                    <div className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      {/* The headline already sits in the card header; this
                        line explains WHY there is no rate. */}
                      <span>{t("audienceUnknownHint")}</span>
                    </div>
                  ) : openUsers.length === 0 ? (
                    <div className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      {t("allAcked")}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="inline-flex items-center gap-1.5 text-sm font-medium">
                        <UserX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        {t("openUsers", { count: openUsers.length })}
                      </div>
                      <ul className="flex flex-wrap gap-1.5">
                        {openUsers.map((u) => (
                          <li
                            key={u.id}
                            className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {userName(u)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            ),
          )}
        </div>
      )}
    </div>
  );
}
