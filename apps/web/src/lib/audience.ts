/**
 * Announcement targeting rules for the web app.
 *
 * Reading an announcement is gated in the CMS by the
 * `announcement-visibility` policy, so pages never need to filter — but
 * the acknowledgement report has to answer the inverse question ("WHO is
 * targeted by this announcement?") and runs as admin_role, which bypasses
 * the policy. It therefore recomputes the target audience with the rules
 * below.
 *
 * Rules (restrictive, AND over every criterion the announcement SETS):
 *   - `department` set          → only that department
 *   - `team` set                → only that team (member OR lead)
 *   - `audienceRoles` non-empty → only those roles
 *   - nothing set               → everyone
 *
 * The `audience` enum ("all" | "departments") is deliberately NOT part of
 * the decision: a set `department` link restricts unconditionally, exactly
 * like `team` and `audienceRoles`. Gating it on `audience === "departments"`
 * made the criteria asymmetric and would silently widen a
 * department-scoped post to the whole company when the enum flips back to
 * "all". `audience = "departments"` WITHOUT a linked department carries no
 * department information, so it cannot restrict and stays company-wide
 * (documented edge case).
 *
 * NOTE — keep in sync with `apps/cms/src/utils/announcement-audience.ts`,
 * which is what the policy actually enforces. The apps are separate Docker
 * build contexts (`apps/web/Dockerfile` copies only `apps/web`), so the
 * module cannot be shared by import; both files carry the same tests.
 *
 * Deliberately NO admin/editor bypass here: that bypass is a read
 * permission ("may see everything"), not audience membership. The report
 * asks who the announcement is FOR, so an editor from another department
 * is not counted toward a department-scoped announcement.
 */

/** A user's organisational scope, as far as targeting cares about it. */
export interface AudienceScope {
  /** users-permissions role id. */
  roleId?: number | null;
  departmentId?: number | null;
  /** Ids of every team the user belongs to — as a MEMBER or as the LEAD. */
  teamIds: number[];
}

/** The targeting fields of one announcement. */
export interface AnnouncementAudience {
  audience?: string | null;
  department?: { id: number } | null;
  team?: { id: number } | null;
  audienceRoles?: { id: number }[] | null;
}

/** Shape of the team rows the report reads from `/api/teams`. */
export interface TeamMembership {
  id: number;
  lead?: { id: number } | null;
  members?: { id: number }[] | null;
}

/**
 * Decide whether `announcement` targets a user with the given scope.
 * Pass `null` for a user whose scope is unknown — they then only match
 * announcements without any targeting criterion.
 */
export function isAnnouncementVisibleTo(
  announcement: AnnouncementAudience,
  scope: AudienceScope | null,
): boolean {
  // A linked department restricts REGARDLESS of the `audience` enum —
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
