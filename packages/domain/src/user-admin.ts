/**
 * User administration in the web (v0.23, deep-dive plan-org-users.md
 * release B): admin_role only. The cms answers fixed DTOs, never a raw user
 * row (no token, oid, token version or password field), and takes exactly
 * USER_ADMIN_FIELDS. Team membership stays on the team (v0.22); creating,
 * deleting and binding accounts stay in the Strapi admin.
 *
 * Refusals use the authoring vocabulary (authoring/codes.ts): 400 with
 * `details.keys`/`details.codes`, e.g. `{ role: "selfChange" }`,
 * `{ department: "entraManaged" }`,
 * `{ manager: "managerCycle" }`, `{ _form: "notEntraBound" }` (v0.25: not bound to any
 * identity provider; the code and the role-to-entra route keep their names).
 */
import type { RoleType } from "./roles.js";

/** The API paths (under /api). */
export const USER_ADMIN_PATH = "user-management";

/** Users per list page. */
export const USER_ADMIN_PAGE_SIZE = 50;

/** The fields PUT /api/user-management/:id takes. */
export const USER_ADMIN_FIELDS = ["role", "department", "manager", "blocked"] as const;
export type UserAdminField = (typeof USER_ADMIN_FIELDS)[number];

/** The list's query: all optional; any other key is refused. */
export interface UserAdminListQuery {
  /** Searches display name, username and e-mail (case-insensitive substring). */
  q?: string;
  role?: RoleType;
  blocked?: "true" | "false";
  page?: number;
}

export interface UserAdminRef {
  documentId: string;
  name: string;
}

/** One user of the list. */
export interface UserAdminRow {
  id: number;
  documentId: string;
  displayName: string;
  email: string;
  /** The intranet role type, or null (no or an unknown role). */
  role: RoleType | null;
  /** Who owns the role: the identity provider (synced at each sign-in) or the intranet. */
  roleSource: "entra" | "oidc" | "manual";
  /** The identity provider the account is bound to (Entra tenant + object id, or OIDC issuer + subject), null for a local account. */
  idp: "entra" | "oidc" | null;
  blocked: boolean;
  department: UserAdminRef | null;
  /** v0.27: a local account invited but without a password yet. */
  invited: boolean;
  /** v0.27: the account has a second factor (TOTP) enabled. */
  mfa: boolean;
  /** v0.28: anonymised (ISO 8601), for good: no field of it can be changed any more. */
  anonymisedAt: string | null;
}

/** One user with everything the edit form shows. */
export interface UserAdminDetail extends UserAdminRow {
  manager: { id: number; displayName: string } | null;
  teams: UserAdminRef[];
  /** ISO 8601. */
  createdAt: string | null;
  /** The caller themself: role and blocked are not theirs to change. */
  self: boolean;
  /** Fields the identity provider's sync owns for this user (refused on save). */
  locked: { department: boolean; manager: boolean };
}

export interface UserAdminListResponse {
  data: UserAdminRow[];
  meta: { page: number; pageSize: number; total: number };
}

export interface UserAdminDetailResponse {
  data: UserAdminDetail;
}

/**
 * POST /api/user-management/invite body `data` (v0.27): a new local
 * account without a password, invited by mail to set one. `role` defaults
 * to member.
 */
export const USER_ADMIN_INVITE_FIELDS = ["email", "displayName", "role", "department"] as const;

export interface UserAdminInvite {
  email: string;
  displayName?: string | null;
  role?: RoleType;
  /** A department's documentId, or null. */
  department?: string | null;
}

/** Whether the mail with the set-password link went out. */
export interface UserAdminMailResponse {
  data: { id: number; mail: "sent" | "failed" };
}

/** PUT body `data`: only the changed fields. */
export interface UserAdminUpdate {
  role?: RoleType;
  /** A department's documentId, or null. */
  department?: string | null;
  /** The manager's user id, or null. */
  manager?: number | null;
  blocked?: boolean;
}
