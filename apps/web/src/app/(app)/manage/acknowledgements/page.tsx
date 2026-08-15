import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardCheck, Clock, UserX } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { isAnnouncementVisibleTo, teamIdsByUser } from "@/lib/audience";
import { isAdmin } from "@/lib/roles";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { fetchAllAnnouncementAcks } from "@/lib/acknowledgements";
import { fetchAllTeams } from "@/lib/teams";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import type { Acknowledgement, Announcement, UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("ackReport");
  return { title: t("title") };
}

type ReportUser = UserLite & {
  department?: { id: number; name: string } | null;
  role?: { id: number; type?: string } | null;
  blocked?: boolean;
};

/** A mandatory announcement plus every field its targeting depends on. */
type ReportAnnouncement = Announcement & {
  audience?: string;
  department?: { id: number; name?: string } | null;
  team?: { id: number; name?: string } | null;
  audienceRoles?: { id: number; type?: string; name?: string }[] | null;
};

/**
 * Role types holding `announcement.find` in the CMS permission matrix
 * (apps/cms/src/index.ts) — only they can ever see, and therefore be
 * expected to confirm, a mandatory announcement. `guest` deliberately has
 * NO announcement read and must not inflate the report's denominator.
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
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    redirect("/");
  }

  const [t, tAdmin, locale] = await Promise.all([
    getTranslations("ackReport"),
    getTranslations("admin"),
    getLocale(),
  ]);

  // admin_role bypasses both the acknowledgement-visibility and the
  // announcement-visibility policy, so these return EVERY user's acks and
  // EVERY announcement — the target audience is recomputed below instead
  // of being handed to us by the API. Users come via the paginated
  // directory helper. All but the teams fetch are per-user/noCache.
  const [announcementsResult, acksResult, usersResult, teamsResult] = await Promise.all([
    tryFetch(
      () =>
        // audienceRoles populate needs `plugin::users-permissions.role.find`,
        // which the CMS bootstrap grants to admin_role for exactly this page.
        strapi<StrapiListResponse<Announcement>>(
          "/api/announcements?filters[requiresAck][$eq]=true&populate[department]=true&populate[team][fields][0]=name&populate[audienceRoles][fields][0]=type&populate[audienceRoles][fields][1]=name&sort=createdAt:desc&pagination[pageSize]=100",
          { noCache: true },
        ),
      "ack-report",
    ),
    tryFetch(() => fetchAllAnnouncementAcks(), "ack-report"),
    tryFetch(
      () =>
        // role is populated the same way people.list does it; blocked is a
        // plain (non-private) users-permissions field.
        fetchAllUsers<ReportUser>(
          "fields[0]=id&fields[1]=username&fields[2]=displayName&fields[3]=email&fields[4]=blocked&populate[department][fields][0]=name&populate[role]=true",
        ),
      "ack-report",
    ),
    // Team membership for team-scoped announcements: `team.lead` has no
    // inverse field on the user, so the mapping can only be built from the
    // team side (lead counts as a member for targeting). MUST be the
    // paginated walk, not `api.teams.list()` — that one sends no pageSize
    // and stops at Strapi's defaultLimit of 25, which would silently empty
    // the target set of every team-scoped announcement past team #25 (see
    // lib/teams.ts).
    tryFetch(() => fetchAllTeams(), "ack-report"),
  ]);

  const anyFailed =
    announcementsResult.failed || acksResult.failed || usersResult.failed || teamsResult.failed;
  // Re-check requiresAck: DEMO_MODE's fixture answers announcement paths
  // unfiltered, and it keeps the report honest if the query ever changes.
  const announcements = (
    (announcementsResult.data?.data ?? []) as ReportAnnouncement[]
  ).filter((a) => a.requiresAck);
  const acks = (acksResult.data ?? []) as Acknowledgement[];
  const users = usersResult.data ?? [];

  // Only unblocked users whose role can actually read announcements count
  // toward the report — a blocked account or a guest can never confirm
  // anything, and would permanently drag every percentage down.
  const eligibleUsers = users.filter(
    (u) => u.blocked !== true && ANNOUNCEMENT_READER_ROLES.has(u.role?.type ?? ""),
  );
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
   */
  const usersUnknown = usersResult.failed;
  const teamsUnknown = teamsResult.failed || (teamsResult.data?.truncated ?? false);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
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

  const rows = announcements.map((a) => {
    // The target set is only as trustworthy as its inputs — a row whose
    // audience cannot be determined is reported as UNKNOWN, never as
    // "everyone confirmed".
    const targetUnknown = usersUnknown || (a.team?.id != null && teamsUnknown);
    // Exactly the targeting the CMS policy enforces on reads (department
    // AND team AND role, over whatever the announcement sets) — the report
    // runs as admin_role, which bypasses that policy, so it has to
    // recompute the audience itself. See lib/audience.ts.
    const targetUsers = eligibleUsers.filter((u) =>
      isAnnouncementVisibleTo(a, {
        roleId: u.role?.id,
        departmentId: u.department?.id,
        teamIds: userTeamIds.get(u.id) ?? [],
      }),
    );
    // Acks anchor on the stable documentId (numeric ids change on every
    // re-publish); the Set dedupes duplicate ack rows (accepted
    // check-then-insert race in the CMS).
    const ackedUserIds = new Set(
      acks
        .filter((k) => k.targetDocumentId === a.documentId)
        .map((k) => k.user?.id)
        .filter((id): id is number => id != null),
    );
    const openUsers = targetUsers.filter((u) => !ackedUserIds.has(u.id));
    const ackedCount = targetUsers.length - openUsers.length;
    const pct =
      targetUsers.length > 0 ? Math.round((ackedCount / targetUsers.length) * 100) : 0;
    return { announcement: a, targetUsers, openUsers, ackedCount, pct, targetUnknown };
  });

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/manage"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {tAdmin("title")}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">{t("description")}</p>
      </div>

      {anyFailed && <FetchErrorBanner />}

      {rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="space-y-4">
          {rows.map(({ announcement: a, targetUsers, openUsers, ackedCount, pct, targetUnknown }) => (
            <Card key={a.id}>
              <CardHeader>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{a.title}</CardTitle>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {audienceLabels(a).map((label) => (
                        <span key={label}>{label}</span>
                      ))}
                      {a.ackDeadline && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {t("deadline", { date: formatDate(a.ackDeadline) })}
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
          ))}
        </div>
      )}
    </div>
  );
}
