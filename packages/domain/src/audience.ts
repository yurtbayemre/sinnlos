/**
 * Announcement targeting: "is this announcement FOR a user with this
 * organisational scope?". One rule for both apps (SH01):
 *   - the cms `announcement-visibility` policy resolves the caller's scope
 *     and the announcement rows from the database and asks this predicate
 *     (apps/cms/src/utils/announcement-audience.ts re-exports it as
 *     `isAnnouncementVisible`); so do the notification fan-out, the digest,
 *     the comment and reaction target checks and the acknowledgement
 *     controller;
 *   - the web acknowledgement report, which runs as admin_role and so
 *     bypasses the policy, recomputes the target audience with it
 *     (apps/web/src/lib/audience.ts, `isAnnouncementVisibleTo`).
 *
 * The rules are restrictive and AND-combined over every criterion that is
 * SET on the announcement:
 *   - `department` set          → only that department
 *   - `team` set                → only that team (member OR lead)
 *   - `audienceRoles` non-empty → only those roles
 *   - nothing set               → everyone, incl. anonymous
 * An announcement with several criteria set requires ALL of them to match.
 *
 * Two rules target NOBODY, whatever else is set (fail closed; decision 06
 * §B6 and §N9, batch 15 lane 15D):
 *   - D-PT01: `audience === "departments"` with neither a department nor a
 *     team linked. The flag says the announcement is restricted, but no
 *     target is left to restrict it TO: a legacy row, an unlink in the
 *     admin panel, or a department or team delete whose cascade removed
 *     the link. Until batch 15 such a row was company-wide.
 *   - `retargetRequired === true` (amendment row A3): a department or team
 *     the announcement targeted was deleted. The criteria are AND-combined,
 *     so dropping one of them would WIDEN the audience (a department plus
 *     team announcement whose department goes would reach the team's
 *     members in other departments; one whose team goes would reach the
 *     whole department). The delete hooks set the marker before the
 *     cascade, and the announcement stays restricted until a moderator
 *     re-targets it.
 * Both mean: readable by moderators only (their read bypass, below) and
 * notified to nobody. `announcementNeedsRetarget` is the same test as a
 * pure helper ("Needs re-targeting" in /manage).
 *
 * A set `department` link restricts REGARDLESS of the `audience` enum.
 * Treating it as a criterion only while `audience === "departments"` made
 * the three criteria asymmetric (`team` and `audienceRoles` always
 * restricted, `department` only conditionally), so flipping the enum back
 * to "all" (or an import/API write that never touches it) would silently
 * widen a department-scoped post to the whole company. The enum only ever
 * narrows (D-PT01).
 *
 * NO admin/editor bypass here, on purpose. The bypass is a READ permission
 * ("may see everything"), not audience membership:
 *   - the cms applies it BEFORE asking this predicate: the visibility policy
 *     and the acknowledgement controller check `hasRole(user, MODERATORS)`
 *     (roles.ts) first, as the other visibility policies do;
 *   - the web report asks who the announcement is FOR, so an editor from
 *     another department is not counted toward a department-scoped one,
 *     and a restricted announcement (D-PT01, the marker) counts nobody.
 *
 * TARGETING SEMANTICS (batch 15 contract K10; decision 06 §B1.2, §N9).
 * The restriction flags are the announcement `audience`, the poll, document
 * and quick-link `audience` (all `"all" | "departments"`) and the event
 * `notifyAudience` (`"all" | "departments"`); the marker is the
 * announcement `retargetRequired`.
 *   - "departments" iff linked, everywhere: every row that links a target
 *     (an announcement's department or team; the departments of a poll,
 *     document, quick link or event) carries "departments". A NULL flag
 *     reads as "all", a NULL marker as false.
 *   - RAISED only by: the write-time targeting guards (Document Service
 *     middlewares; cms utils/poll-audience-guard.ts, department-audience-
 *     guard.ts, targeting-flags.ts), the department and team delete hooks
 *     (before the cascade), and the boot backfills (cms utils/*-backfill.ts).
 *     None of them ever lowers a flag or the marker. Raw writes that only
 *     raise are exempt from the revision rule (§G "Rule"): a raised flag
 *     only restricts.
 *   - LOWERED only by an explicit re-target. Through the authoring
 *     allowlist (cms utils/write-allowlist.ts, from batch 15 lane 15A) a
 *     flag is re-derived ("departments" iff linked) only when the payload
 *     carries a targeting key (`department`/`team` for announcements,
 *     `departments` for the other types), and the marker is set to false
 *     only when the payload carries `department`, `team` or
 *     `audienceRoles`; a payload without one leaves both alone, so a stale
 *     form never widens. In the admin panel a moderator lowers them by
 *     setting the field itself (Audience `all`, Retarget required off): a
 *     deliberate break-glass edit, which the guards then re-raise on any
 *     row that still links a target.
 *   - The flags only ever restrict reads (announcement: this predicate;
 *     poll, document, quick link: "flag OR links" in the cms read policies)
 *     and notifications (event: `eventNeedsRetarget` notifies nobody;
 *     events stay readable calendar-wide).
 */

/** The flag value that restricts (`audience`, `notifyAudience`). */
export const AUDIENCE_DEPARTMENTS = "departments";

/**
 * A user's organisational scope, resolved from the database. All row ids:
 * roles, departments and teams are not draft & publish (department and team
 * since decision 05, single-row with stable ids), so they match the ids an
 * announcement row links to, whichever of its rows is checked.
 */
export interface AudienceScope {
  /** users-permissions role id. */
  roleId?: number | null;
  departmentId?: number | null;
  /** Ids of every team the user belongs to: as a MEMBER or as the LEAD. */
  teamIds: number[];
}

/** The targeting fields of one announcement row. */
export interface AnnouncementTargeting {
  audience?: string | null;
  department?: { id: number } | null;
  team?: { id: number } | null;
  audienceRoles?: { id: number }[] | null;
  /**
   * The re-target marker (amendment row A3): true targets nobody. Optional,
   * so a caller that does not select it reads as before; every cms and web
   * caller selects it since batch 15.
   */
  retargetRequired?: boolean | null;
}

/**
 * What `announcementNeedsRetarget` reads. A relation counts as linked when
 * it is present (any populated row shape: `{ id }`, `{ documentId }`).
 */
export interface AnnouncementRetargetFields {
  audience?: string | null;
  department?: object | null;
  team?: object | null;
  retargetRequired?: boolean | null;
}

/** What `scopedNeedsRetarget` reads (document, quick-link, poll). */
export interface ScopedRetargetFields {
  audience?: string | null;
  /** The linked departments, in any populated row shape. */
  departments?: readonly unknown[] | null;
}

/** What `eventNeedsRetarget` reads. */
export interface EventRetargetFields {
  notifyAudience?: string | null;
  /** The linked departments, in any populated row shape. */
  departments?: readonly unknown[] | null;
}

const hasLinks = (links: readonly unknown[] | null | undefined): boolean =>
  Array.isArray(links) && links.length > 0;

/**
 * True when the announcement targets nobody until a moderator re-targets
 * it: the marker is set, or D-PT01 (restricted without a department or a
 * team). See the module header.
 */
export function announcementNeedsRetarget(row: AnnouncementRetargetFields): boolean {
  if (row.retargetRequired === true) return true;
  return row.audience === AUDIENCE_DEPARTMENTS && row.department == null && row.team == null;
}

/**
 * True when a document, quick link or poll is restricted ("departments")
 * without a department left: moderators only until re-targeted (the FX29
 * residual and the poll rule of decision 02).
 */
export function scopedNeedsRetarget(row: ScopedRetargetFields): boolean {
  return row.audience === AUDIENCE_DEPARTMENTS && !hasLinks(row.departments);
}

/**
 * True when an event notifies a restricted audience ("departments") without
 * a department left: it notifies nobody until re-targeted. The event itself
 * stays readable calendar-wide.
 */
export function eventNeedsRetarget(row: EventRetargetFields): boolean {
  return row.notifyAudience === AUDIENCE_DEPARTMENTS && !hasLinks(row.departments);
}

/**
 * Decide whether `announcement` targets `scope`. Pass `null` for an
 * anonymous caller or a user whose scope is unknown: they only match
 * announcements without any targeting criterion.
 */
export function isAnnouncementTargetedTo(
  announcement: AnnouncementTargeting,
  scope: AudienceScope | null,
): boolean {
  // D-PT01 and the re-target marker: nobody (see the module header).
  if (announcementNeedsRetarget(announcement)) return false;

  // A linked department restricts REGARDLESS of the `audience` enum, the
  // same shape as the team / role criteria below (see the module header).
  // A link without an id matches nobody (unknown target, fail closed).
  const department = announcement.department;
  if (department != null) {
    if (scope?.departmentId == null || scope.departmentId !== department.id) return false;
  }

  const team = announcement.team;
  if (team != null) {
    if (!(scope?.teamIds ?? []).includes(team.id)) return false;
  }

  const roles = announcement.audienceRoles ?? [];
  if (roles.length > 0) {
    if (scope?.roleId == null || !roles.some((role) => role.id === scope.roleId)) return false;
  }

  return true;
}

/** Shape of the team rows the web report reads from `/api/teams`. */
export interface TeamMembership {
  id: number;
  lead?: { id: number } | null;
  members?: { id: number }[] | null;
}

/**
 * Index user id → ids of the teams that user belongs to, counting both
 * membership and lead. `team.lead` has no inverse field on the user, so
 * the mapping can only be built from the team side.
 */
export function teamIdsByUser(teams: TeamMembership[]): Map<number, number[]> {
  const index = new Map<number, number[]>();
  const add = (userId: number | undefined | null, teamId: number) => {
    if (userId == null) return;
    const current = index.get(userId);
    if (current) {
      if (!current.includes(teamId)) current.push(teamId);
    } else {
      index.set(userId, [teamId]);
    }
  };
  for (const team of teams) {
    add(team.lead?.id, team.id);
    for (const member of team.members ?? []) add(member?.id, team.id);
  }
  return index;
}
