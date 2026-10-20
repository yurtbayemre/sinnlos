import { teamIdsByUser } from "@/lib/audience";
import {
  buildAckReportRows,
  buildDocumentAckRows,
  eligibleReportUsers,
  reportCompleteness,
  type ReportAnnouncement,
  type ReportUser,
} from "@/lib/ack-report";
import { fetchAnnouncementAckIndex, fetchDocumentAckIndex } from "@/lib/acknowledgements";
import { listAckReportAnnouncements } from "@/lib/api/announcements";
import { listDocumentsRequiringAck } from "@/lib/api/documents";
import { ACKNOWLEDGER_ROLES, ANNOUNCEMENT_READER_ROLES } from "@/lib/roles";
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
  /**
   * The documents that require acknowledgement (v0.20), in the same shape:
   * `audience.department` lists the linked departments' names.
   */
  documentRows: AckReportRowView[];
  /** Both reads answered with none: the empty state (not on an outage). */
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
  const [announcementsResult, usersResult, teamsResult, documentsResult] = await Promise.all([
    // Every mandatory announcement with its targeting fields, a full walk
    // (the audienceRoles populate needs the role.find grant admin_role
    // holds for exactly this page).
    tryFetch(() => listAckReportAnnouncements(), "ack-report"),
    tryFetch(() => fetchAllUsers<ReportUser>(ACK_REPORT_USER_QUERY), "ack-report"),
    // Team membership for team-scoped announcements: `team.lead` has no
    // inverse field on the user, so the mapping is built from the team
    // side (field-limited to ids, with its own truncated signal).
    tryFetch(() => fetchAllTeams(), "ack-report"),
    // Every document that requires acknowledgement (admin_role bypasses
    // document-visibility) with its departments and flag.
    tryFetch(() => listDocumentsRequiringAck(), "ack-report"),
  ]);

  // Re-check requiresAck: DEMO_MODE's fixture answers announcement paths
  // unfiltered, and it keeps the report honest if the query ever changes.
  const announcements = (announcementsResult.data?.data ?? []).filter((a) => a.requiresAck);
  // The acks of exactly the listed announcements, per chunk of documentIds
  // with a cap per chunk (FX32). They need the announcements first.
  const documents = (documentsResult.data?.data ?? []).filter((d) => d.requiresAck);
  const idsOf = (rows: { documentId?: string }[]) =>
    rows.map((row) => row.documentId).filter((id): id is string => !!id);
  const [acksResult, documentAcksResult] = await Promise.all([
    tryFetch(() => fetchAnnouncementAckIndex(idsOf(announcements)), "ack-report"),
    tryFetch(() => fetchDocumentAckIndex(idsOf(documents)), "ack-report"),
  ]);

  // Fail closed: a missing input never reads as "nobody is targeted"
  // (0 of 0 → 100% → a green "everyone confirmed"). Without the directory
  // no row has an audience; without the team roster only the team-scoped
  // rows lose theirs (lib/ack-report.ts reportCompleteness).
  const { usersUnknown, teamsUnknown, truncated } = reportCompleteness({
    usersFailed: usersResult.failed,
    usersTruncated: usersResult.data?.truncated ?? false,
    teamsFailed: teamsResult.failed,
    teamsTruncated: teamsResult.data?.truncated ?? false,
    acksFailed: acksResult.failed || documentAcksResult.failed,
    acksTruncated: !!acksResult.data?.truncated || !!documentAcksResult.data?.truncated,
    announcementsFailed: announcementsResult.failed || documentsResult.failed,
    announcementsTruncated:
      !!announcementsResult.data?.truncated || !!documentsResult.data?.truncated,
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

  const documentRows = buildDocumentAckRows({
    documents,
    acks: documentAcksResult.data?.index ?? new Map<string, Set<number>>(),
    // Guest reads documents but holds no acknowledgement grant.
    eligibleUsers: eligibleReportUsers(usersResult.data?.users ?? [], ACKNOWLEDGER_ROLES),
    usersUnknown,
  });
  const openNames = (users: ReportUser[]) =>
    users.map((u) => ({ id: u.id, name: displayNameOf(u, `#${u.id}`) }));

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
        openUsers: openNames(openUsers),
      }),
    ),
    documentRows: documentRows.map(
      ({ document: d, targetUsers, openUsers, ackedCount, pct, targetUnknown }) => ({
        id: d.id,
        title: d.title ?? "",
        audience: {
          department:
            (d.departments ?? []).map((dep) => dep.name ?? `#${dep.id}`).join(", ") || null,
          team: null,
          roles: [],
        },
        ackDeadline: null,
        targetUnknown,
        pct,
        ackedCount,
        targetTotal: targetUsers.length,
        openUsers: openNames(openUsers),
      }),
    ),
    empty:
      !announcementsResult.failed &&
      !documentsResult.failed &&
      rows.length === 0 &&
      documentRows.length === 0,
    failed:
      announcementsResult.failed ||
      acksResult.failed ||
      usersResult.failed ||
      teamsResult.failed ||
      documentsResult.failed ||
      documentAcksResult.failed,
    truncated,
  };
}
