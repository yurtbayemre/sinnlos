/**
 * Announcement targeting rules — the single source of truth for "may this
 * user see this announcement".
 *
 * Pure functions, no Strapi runtime: the `announcement-visibility` policy
 * resolves the caller's scope and the announcement rows from the DB and
 * then asks THESE functions, so the security decision itself is unit
 * testable without a running Strapi (see `announcement-audience.test.ts`).
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
 * `audience === "departments"` made the three criteria asymmetric — `team`
 * and `audienceRoles` always restricted, `department` only conditionally —
 * so flipping the enum back to "all" (or an import/API write that never
 * touches it) would silently widen a department-scoped post to the whole
 * company. A set relation restricting unconditionally is the fail-closed
 * reading and matches the other two criteria. Live data is unaffected: the
 * only department-linked announcement carries `audience = "departments"`
 * anyway.
 *
 * Remaining edge case (documented, not enforced): `audience =
 * "departments"` WITHOUT a linked department carries no department
 * information at all, so there is nothing to restrict TO and the
 * announcement stays company-wide.
 *
 * NOTE — keep in sync with `apps/web/src/lib/audience.ts`, which applies
 * the same rules to compute the target audience of the acknowledgement
 * report. The two apps are separate Docker build contexts (see
 * `apps/web/Dockerfile`: only `apps/web` is copied), so the module cannot
 * be shared by import; both files carry the same tests.
 */

/** The caller's organisational scope, resolved from the database. */
export interface AudienceScope {
  /** users-permissions role id (roles are not draft & publish). */
  roleId?: number | null;
  departmentId?: number | null;
  /** Ids of every team the user belongs to — as a MEMBER or as the LEAD. */
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
 * Roles that read every announcement regardless of targeting: they
 * author and moderate them, so a filtered list would hide their own work.
 * Mirrors the bypass of the other visibility policies (document, wiki,
 * quick-link).
 */
const BYPASS_ROLE_TYPES = ["admin_role", "editor"];

export function hasAudienceBypass(roleType?: string | null): boolean {
  return roleType != null && BYPASS_ROLE_TYPES.includes(roleType);
}

/**
 * Decide whether `announcement` is visible to `scope`.
 * Pass `null` for anonymous callers — they only ever see announcements
 * without any targeting criterion.
 */
export function isAnnouncementVisible(
  announcement: AnnouncementTargeting,
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
