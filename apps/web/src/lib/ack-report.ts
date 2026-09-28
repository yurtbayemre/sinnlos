/**
 * Fail-closed completeness derivation for the acknowledgement report.
 *
 * The report recomputes each mandatory announcement's target audience from
 * four independent list walks: the mandatory announcements themselves, the
 * acknowledgements, the team roster and the user directory. Every one of
 * those walks stops at a hard safety cap, and if any is cut short the
 * recomputed numbers can only come out too LOW — a shrunken audience reads
 * as HIGHER compliance, a missing ack row reads as an open (non-confirming)
 * user, a dropped announcement vanishes from the report entirely. None of
 * that may be presented as a complete, green "everyone confirmed" (#14).
 *
 * This is a pure function so the fail-closed rule can be unit-tested without
 * the page's Next.js / Strapi runtime.
 */

import { isAnnouncementVisibleTo, type AnnouncementAudience } from "@/lib/audience";

export interface ReportInputs {
  usersFailed: boolean;
  /** Directory walk stopped at its cap (see users.ts MAX_USERS). */
  usersTruncated: boolean;
  teamsFailed: boolean;
  teamsTruncated: boolean;
  acksFailed: boolean;
  acksTruncated: boolean;
  announcementsFailed: boolean;
  announcementsTruncated: boolean;
}

export interface ReportCompleteness {
  /**
   * The user directory could not be fully determined (fetch failed or the
   * walk was truncated) — EVERY row's audience is unknown, because no user
   * can be reliably placed, so no rate may be shown.
   */
  usersUnknown: boolean;
  /**
   * The team roster could not be fully determined — only rows carrying a
   * `team` criterion are affected; department- and role-scoped rows stay
   * exact.
   */
  teamsUnknown: boolean;
  /**
   * At least one input list was cut short by its safety cap: the report is
   * INCOMPLETE and its totals may be too low. Drives the warning banner and
   * forbids any "complete / all confirmed" reading. Fetch FAILURES are not
   * folded in here — the page surfaces those via its CMS-down banner and the
   * per-row unknown state — so this flag is specifically the silent-cap case.
   */
  truncated: boolean;
}

export function reportCompleteness(inputs: ReportInputs): ReportCompleteness {
  return {
    usersUnknown: inputs.usersFailed || inputs.usersTruncated,
    teamsUnknown: inputs.teamsFailed || inputs.teamsTruncated,
    truncated:
      inputs.usersTruncated ||
      inputs.teamsTruncated ||
      inputs.acksTruncated ||
      inputs.announcementsTruncated,
  };
}

// ---------------------------------------------------------------------------
// Report rows (WD02: moved out of app/(app)/manage/acknowledgements/page.tsx)
// ---------------------------------------------------------------------------

/** A directory row as the report reads it (/api/users with role and department). */
export interface ReportUser {
  id: number;
  username?: string;
  email?: string;
  displayName?: string;
  department?: { id: number; name?: string } | null;
  role?: { id: number; type?: string } | null;
  blocked?: boolean;
}

/** A mandatory announcement plus every field its targeting depends on. */
export interface ReportAnnouncement extends AnnouncementAudience {
  id: number;
  documentId?: string;
  title?: string;
  requiresAck?: boolean;
  ackDeadline?: string | null;
  department?: { id: number; name?: string } | null;
  team?: { id: number; name?: string } | null;
  audienceRoles?: { id: number; type?: string; name?: string }[] | null;
}

/** One acknowledgement as the report needs it: whose, and for which document. */
export interface ReportAck {
  targetDocumentId: string;
  user?: { id: number } | null;
}

export interface AckReportRow<U extends ReportUser, A extends ReportAnnouncement> {
  announcement: A;
  /** The users the announcement targets (meaningless when targetUnknown). */
  targetUsers: U[];
  openUsers: U[];
  ackedCount: number;
  /** Confirmation rate in whole percent; 0 for an empty audience. */
  pct: number;
  /** The audience cannot be determined: render "–", never a rate. */
  targetUnknown: boolean;
}

/**
 * Only unblocked users whose role can actually read announcements count
 * toward the report — a blocked account or a guest can never confirm
 * anything, and would permanently drag every percentage down. The page
 * passes its ANNOUNCEMENT_READER_ROLES (the role types holding
 * announcement.find; infra/contracts.test.ts pins that page-local copy
 * against the CMS matrix until SH02 moves it).
 */
export function eligibleReportUsers<U extends ReportUser>(
  users: U[],
  readerRoles: ReadonlySet<string>,
): U[] {
  return users.filter((u) => u.blocked !== true && readerRoles.has(u.role?.type ?? ""));
}

/**
 * One row per mandatory announcement. The target set is only as
 * trustworthy as its inputs: without the user directory NO row has a
 * determinable audience, and without the team roster the rows with a
 * `team` criterion do not (fail closed, see reportCompleteness). The
 * audience is exactly the targeting the CMS policy enforces on reads
 * (lib/audience.ts): the report runs as admin_role, which bypasses that
 * policy, so it recomputes it. Acks match on the stable documentId (numeric
 * ids change on every re-publish); a Set dedupes duplicate ack rows (the
 * accepted check-then-insert race in the CMS).
 */
export function buildAckReportRows<U extends ReportUser, A extends ReportAnnouncement>(input: {
  announcements: A[];
  acks: ReportAck[];
  /** Already narrowed with eligibleReportUsers. */
  eligibleUsers: U[];
  userTeamIds: Map<number, number[]>;
  usersUnknown: boolean;
  teamsUnknown: boolean;
}): AckReportRow<U, A>[] {
  const { announcements, acks, eligibleUsers, userTeamIds, usersUnknown, teamsUnknown } = input;
  return announcements.map((a) => {
    const targetUnknown = usersUnknown || (a.team?.id != null && teamsUnknown);
    const targetUsers = eligibleUsers.filter((u) =>
      isAnnouncementVisibleTo(a, {
        roleId: u.role?.id,
        departmentId: u.department?.id,
        teamIds: userTeamIds.get(u.id) ?? [],
      }),
    );
    const ackedUserIds = new Set(
      acks
        .filter((k) => k.targetDocumentId === a.documentId)
        .map((k) => k.user?.id)
        .filter((id): id is number => id != null),
    );
    const openUsers = targetUsers.filter((u) => !ackedUserIds.has(u.id));
    const ackedCount = targetUsers.length - openUsers.length;
    const pct = targetUsers.length > 0 ? Math.round((ackedCount / targetUsers.length) * 100) : 0;
    return { announcement: a, targetUsers, openUsers, ackedCount, pct, targetUnknown };
  });
}
