/**
 * Web-side role gates. UX only: the CMS permission matrix and route policies
 * (apps/cms/src/index.ts PERMISSION_MATRIX / CUSTOM_ACTION_GRANTS) enforce
 * every rule on their own; these helpers keep the UI from offering what the
 * CMS would refuse.
 *
 * `role` is the viewer's role type from getViewer() (lib/viewer.ts), never
 * a value frozen into the session (D-SESSION-01). Every predicate is
 * FAIL-CLOSED and exact: null, undefined, an unknown or differently-cased
 * value never grants anything. Exclusion checks such as `role !== "guest"`
 * are not allowed — they let every session without a readable role through
 * (investigations.md #1: Microsoft sessions carried role undefined).
 * SH02 later pins these sets to the CMS matrix.
 */
type Role = string | null | undefined;

export const ADMIN_ROLES: ReadonlySet<string> = new Set(["admin_role"]);

/** Poll create: global::is-admin-or-editor on the CMS route. */
export const POLL_CREATOR_ROLES: ReadonlySet<string> = new Set(["admin_role", "editor"]);

/**
 * event-rsvp create/update grants. guest has none (the RSVP fetch would 403);
 * the `authenticated` fallback role does hold them.
 */
export const RSVP_ROLES: ReadonlySet<string> = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "authenticated",
]);

/**
 * Posting an ad needs classified create AND the content-api upload grant:
 * the five staff roles only — never guest or the `authenticated` fallback.
 */
export const AD_POSTER_ROLES: ReadonlySet<string> = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
]);

function hasRole(allowed: ReadonlySet<string>, role: Role): boolean {
  return typeof role === "string" && allowed.has(role);
}

export function isAdmin(role: Role): boolean {
  return hasRole(ADMIN_ROLES, role);
}

export function canCreatePolls(role: Role): boolean {
  return hasRole(POLL_CREATOR_ROLES, role);
}

export function canRsvp(role: Role): boolean {
  return hasRole(RSVP_ROLES, role);
}

export function canPostAds(role: Role): boolean {
  return hasRole(AD_POSTER_ROLES, role);
}
