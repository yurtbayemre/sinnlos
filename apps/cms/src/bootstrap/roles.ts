/**
 * The cms role vocabulary (roadmap B02): the users-permissions role types
 * the bootstrap seeds, and the role sets the policies, controllers and
 * sanitizers decide by. Every inline role list derives from here, so a typo
 * fails `tsc` instead of silently granting or denying at runtime.
 *
 * The type strings are a contract with the web (lib/roles.ts reads
 * `role.type` from /api/users/me): the admin role is `admin_role`, not
 * `admin`. Pure data, no Strapi runtime and no side effects at load time
 * (config/ms-role-map.ts imports it while the config loads).
 *
 * Extend, never rename or remove an export: the Entra sign-in (batch 4)
 * imports RoleType and ROLE_PRIVILEGE_ORDER.
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
 * intranet role. The plugin creates it, not our seed; PERMISSION_MATRIX
 * grants it baseline reads as a fallback.
 */
export const AUTHENTICATED = "authenticated";

/** A role PERMISSION_MATRIX grants to: ours plus the built-in fallback. */
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

export type RoleSeed = {
  name: string;
  type: RoleType;
  description: string;
};

/** The roles bootstrap/sync-permissions.ts ensureRoles creates, in this order. */
export const ROLES: readonly RoleSeed[] = [
  {
    name: "Admin",
    type: "admin_role",
    description: "Full CRUD across the intranet + user management",
  },
  {
    name: "Editor",
    type: "editor",
    description: "Full CRUD over wiki and announcements",
  },
  {
    name: "Department Head",
    type: "department_head",
    description: "Manages their own department + its teams and pages",
  },
  {
    name: "Team Lead",
    type: "team_lead",
    description: "Manages their own team pages and members",
  },
  {
    name: "Member",
    type: "member",
    description: "Reads everything their scope permits + edits own profile",
  },
  {
    name: "Guest",
    type: "guest",
    description: "Read-only access to public wiki spaces",
  },
];
