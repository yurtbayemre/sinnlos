/**
 * The cms role vocabulary (roadmap B02): the users-permissions role types
 * the bootstrap seeds, and the role sets the policies, controllers and
 * sanitizers decide by. Every inline role list derives from here, so a typo
 * fails `tsc` instead of silently granting or denying at runtime.
 *
 * The vocabulary itself (role types, sets, isRoleType, hasRole) lives in
 * @sinnlos/domain (SH01, packages/domain/src/roles.ts) and is re-exported
 * here under the same names; the seed list (ROLES) is the bootstrap's own.
 * The type strings are a contract with the web (lib/roles.ts reads
 * `role.type` from /api/users/me): the admin role is `admin_role`, not
 * `admin`. Pure data, no Strapi runtime and no side effects at load time
 * (entra/config.ts imports it, and register() loads that before the
 * bootstrap).
 *
 * Extend, never rename or remove an export: the Entra sign-in
 * (entra/roles.ts) imports RoleType and ROLE_PRIVILEGE_ORDER.
 */
import type { RoleType } from "@sinnlos/domain";

export {
  ADMIN,
  AUTHENTICATED,
  GUEST,
  MODERATORS,
  ROLE_PRIVILEGE_ORDER,
  STAFF_ROLES,
  hasRole,
  isRoleType,
  type MatrixRoleType,
  type RoleHolder,
  type RoleType,
} from "@sinnlos/domain";

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
