/**
 * Announcement targeting: "is this announcement FOR a user with this
 * organisational scope?". One rule for both apps (SH01):
 *   - the cms `announcement-visibility` policy resolves the caller's scope
 *     and the announcement rows from the database and asks this predicate
 *     (apps/cms/src/utils/announcement-audience.ts re-exports it as
 *     `isAnnouncementVisible`);
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
 * The `audience` enum ("all" | "departments") is deliberately NOT part of
 * the decision. Treating a set `department` link as a criterion only while
 * `audience === "departments"` made the three criteria asymmetric (`team`
 * and `audienceRoles` always restricted, `department` only conditionally),
 * so flipping the enum back to "all" (or an import/API write that never
 * touches it) would silently widen a department-scoped post to the whole
 * company. A set relation restricting unconditionally is the fail-closed
 * reading and matches the other two criteria. Remaining edge case
 * (documented, not enforced): `audience = "departments"` WITHOUT a linked
 * department carries no department information, so there is nothing to
 * restrict TO and the announcement stays company-wide.
 *
 * NO admin/editor bypass here, on purpose. The bypass is a READ permission
 * ("may see everything"), not audience membership:
 *   - the cms applies it BEFORE asking this predicate: the visibility policy
 *     and the acknowledgement controller check `hasRole(user, MODERATORS)`
 *     (roles.ts) first, as the other visibility policies do;
 *   - the web report asks who the announcement is FOR, so an editor from
 *     another department is not counted toward a department-scoped one.
 */

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
  // A linked department restricts REGARDLESS of the `audience` enum, the
  // same shape as the team / role criteria below (see the module header).
  const departmentId = announcement.department?.id;
  if (departmentId != null) {
    if (scope?.departmentId == null || scope.departmentId !== departmentId) return false;
  }

  const teamId = announcement.team?.id;
  if (teamId != null) {
    if (!(scope?.teamIds ?? []).includes(teamId)) return false;
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
