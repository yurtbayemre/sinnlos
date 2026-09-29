/**
 * The intranet role vocabulary (roadmap B02): the users-permissions role
 * types the cms bootstrap seeds and the role sets its policies, controllers
 * and sanitizers decide by. apps/cms/src/bootstrap/roles.ts re-exports all
 * of it (next to its seed list, ROLES), so every inline role list derives
 * from here and a typo fails `tsc` instead of silently granting or denying
 * at runtime.
 *
 * The type strings are a contract with every users-permissions database and
 * with the web (lib/roles.ts reads `role.type` from /api/users/me): the
 * admin role is `admin_role`, not `admin`. Pure data, no side effects at
 * load time.
 *
 * Extend, never rename or remove an export: the Entra sign-in
 * (apps/cms/src/entra/roles.ts) imports RoleType and ROLE_PRIVILEGE_ORDER.
 */

/**
 * Every intranet role type, most privileged first. Where one role has to be
 * chosen from several matches (the Entra role resolution: the highest
 * privilege wins), this is the order.
 */
export const ROLE_PRIVILEGE_ORDER = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "guest",
] as const;

/** A users-permissions role type the bootstrap seeds. */
export type RoleType = (typeof ROLE_PRIVILEGE_ORDER)[number];

/**
 * users-permissions' built-in role for a signed-in user without an
 * intranet role. The plugin creates it, not our seed; the cms
 * PERMISSION_MATRIX grants it baseline reads as a fallback.
 */
export const AUTHENTICATED = "authenticated";

/** A role the cms PERMISSION_MATRIX grants to: ours plus the built-in fallback. */
export type MatrixRoleType = RoleType | typeof AUTHENTICATED;

/** The administrator role: full access, and the only personal-data bypass. */
export const ADMIN = "admin_role" satisfies RoleType;

/** The read-only role for guests. */
export const GUEST = "guest" satisfies RoleType;

/** The roles that moderate and author content: admin_role and editor. */
export const MODERATORS: readonly RoleType[] = [ADMIN, "editor"];

/** Every intranet role except guest: the employees. */
export const STAFF_ROLES: readonly RoleType[] = ROLE_PRIVILEGE_ORDER.filter(
  (role) => role !== GUEST,
);

/** True when `value` is one of the seeded role types. */
export function isRoleType(value: unknown): value is RoleType {
  return (ROLE_PRIVILEGE_ORDER as readonly unknown[]).includes(value);
}

/**
 * What a role check reads from a caller: users-permissions puts the user
 * with its populated role on ctx.state.user (policies, controllers) and the
 * request context.
 */
export interface RoleHolder {
  role?: { type?: unknown } | null;
}

/**
 * Whether the caller's role type is one of `roles` (PL01): the one role
 * check the cms policies, controllers and utils decide bypasses by. The
 * match is exact, so "Admin_role", " editor" or "admin" never pass, and a
 * caller without a user, a role or a string role type holds none. `roles`
 * is typed as RoleType, so a misspelt role fails `tsc`; a list from route
 * config goes through isRoleType first.
 */
export function hasRole(user: RoleHolder | null | undefined, roles: readonly RoleType[]): boolean {
  const type = user?.role?.type;
  return typeof type === "string" && (roles as readonly string[]).includes(type);
}
