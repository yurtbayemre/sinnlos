import { teamIdsByUser } from "@/lib/audience";
import {
  buildAckReportRows,
  eligibleReportUsers,
  reportCompleteness,
  type ReportAnnouncement,
  type ReportUser,
} from "@/lib/ack-report";
import { fetchAnnouncementAckIndex } from "@/lib/acknowledgements";
import { listAckReportAnnouncements } from "@/lib/api/announcements";
import { ANNOUNCEMENT_READER_ROLES } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { fetchAllTeams } from "@/lib/teams";
import { fetchAllUsers } from "@/lib/users";
import { displayNameOf } from "@/lib/utils";

/**
 * The /manage/acknowledgements report (WD03; the rules: lib/ack-report.ts,
 * FX32). admin_role bypasses both the acknowledgement-visibility and the
 * announcement-visibility policy, so the reads return EVERY mandatory
 * announcement and every user's acks of them; the target audience is
 * recomputed here instead of being handed over by the API.
 */

/**
 * The directory columns the report reads: role via the users-permissions
 * role.find grant, `blocked` a plain field.
 */
export const ACK_REPORT_USER_QUERY =
  "fields[0]=id&fields[1]=username&fields[2]=displayName&fields[3]=email&fields[4]=blocked&populate[department][fields][0]=name&populate[role]=true";

/** Whom a mandatory announcement targets, as the page labels it. */
export interface AckReportAudience {
  /** The linked department's name (or #id); a link restricts unconditionally. */
  department: string | null;
  team: string | null;
  /** The targeted roles' names (or type, or #id). */
  roles: string[];
}

export interface AckReportRowView {
  id: number;
  title: string;
  audience: AckReportAudience;
  /** A calendar date (YYYY-MM-DD), shown as that day; null: none. */
  ackDeadline: string | null;
  /** The audience cannot be determined: "–", never a rate. */
  targetUnknown: boolean;
  /** Whole percent; meaningless when targetUnknown. */
  pct: number;
  ackedCount: number;
  targetTotal: number;
  /** Who has not confirmed yet, named by displayNameOf (else #id). */
  openUsers: { id: number; name: string }[];
}

export interface AckReportView {
  rows: AckReportRowView[];
  /** The announcements read answered with none: the empty state (not on an outage). */
  empty: boolean;
  /** A read failed: the CMS-down banner (and the affected rows unknown). */
  failed: boolean;
  /**
   * An input walk stopped at its cap: the numbers may be too low, so the
   * report warns and never reads as complete (#14).
   */
  truncated: boolean;
}

function audienceOf(a: ReportAnnouncement): AckReportAudience {
  return {
    department: a.department?.id != null ? (a.department.name ?? `#${a.department.id}`) : null,
    team: a.team?.id != null ? (a.team.name ?? `#${a.team.id}`) : null,
    roles: (a.audienceRoles ?? []).map((r) => r.name ?? r.type ?? `#${r.id}`),
  };
}

/** Everything the report renders; the reads are the ones of before WD03. */
export async function loadAckReport(): Promise<AckReportView> {
  const [announcementsResult, usersResult, teamsResult] = await Promise.all([
    // Every mandatory announcement with its targeting fields, a full walk
    // (the audienceRoles populate needs the role.find grant admin_role
    // holds for exactly this page).
    tryFetch(() => listAckReportAnnouncements(), "ack-report"),
    tryFetch(() => fetchAllUsers<ReportUser>(ACK_REPORT_USER_QUERY), "ack-report"),
    // Team membership for team-scoped announcements: `team.lead` has no
    // inverse field on the user, so the mapping is built from the team
    // side (field-limited to ids, with its own truncated signal).
    tryFetch(() => fetchAllTeams(), "ack-report"),
  ]);

  // Re-check requiresAck: DEMO_MODE's fixture answers announcement paths
  // unfiltered, and it keeps the report honest if the query ever changes.
  const announcements = (announcementsResult.data?.data ?? []).filter((a) => a.requiresAck);
  // The acks of exactly the listed announcements, per chunk of documentIds
  // with a cap per chunk (FX32). They need the announcements first.
  const acksResult = await tryFetch(
    () =>
      fetchAnnouncementAckIndex(
        announcements.map((a) => a.documentId).filter((id): id is string => !!id),
      ),
    "ack-report",
  );

  // Fail closed: a missing input never reads as "nobody is targeted"
  // (0 of 0 → 100% → a green "everyone confirmed"). Without the directory
  // no row has an audience; without the team roster only the team-scoped
  // rows lose theirs (lib/ack-report.ts reportCompleteness).
  const { usersUnknown, teamsUnknown, truncated } = reportCompleteness({
    usersFailed: usersResult.failed,
    usersTruncated: usersResult.data?.truncated ?? false,
    teamsFailed: teamsResult.failed,
    teamsTruncated: teamsResult.data?.truncated ?? false,
    acksFailed: acksResult.failed,
    acksTruncated: acksResult.data?.truncated ?? false,
    announcementsFailed: announcementsResult.failed,
    announcementsTruncated: announcementsResult.data?.truncated ?? false,
  });

  const rows = buildAckReportRows({
    announcements,
    acks: acksResult.data?.index ?? new Map<string, Set<number>>(),
    // Only unblocked users whose role can read announcements count.
    eligibleUsers: eligibleReportUsers(usersResult.data?.users ?? [], ANNOUNCEMENT_READER_ROLES),
    userTeamIds: teamIdsByUser(teamsResult.data?.teams ?? []),
    usersUnknown,
    teamsUnknown,
  });

  return {
    rows: rows.map(
      ({ announcement: a, targetUsers, openUsers, ackedCount, pct, targetUnknown }) => ({
        id: a.id,
        title: a.title ?? "",
        audience: audienceOf(a),
        ackDeadline: a.ackDeadline ?? null,
        targetUnknown,
        pct,
        ackedCount,
        targetTotal: targetUsers.length,
        openUsers: openUsers.map((u) => ({ id: u.id, name: displayNameOf(u, `#${u.id}`) })),
      }),
    ),
    empty: !announcementsResult.failed && rows.length === 0,
    failed:
      announcementsResult.failed || acksResult.failed || usersResult.failed || teamsResult.failed,
    truncated,
  };
}
