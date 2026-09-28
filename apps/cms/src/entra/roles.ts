/**
 * Entra role resolution and the role write decision (D-ENTRA-01 spec H and
 * I). Pure. Replaces the deleted config/ms-role-map.ts, which matched group
 * display names (anyone who can name a group could pick their role) and
 * demoted on every Graph error.
 *
 * Sources, all by stable id, never by name:
 *   - app roles from the SIGNED ID token (`roles` claim, APP_ROLE_TABLE):
 *     the primary mechanism, no Graph call, no failure mode;
 *   - optionally ENTRA_GROUP_ROLES, group object ids checked through
 *     /me/checkMemberGroups (transitive; for nested groups or tenants
 *     without Entra ID P1).
 * The highest privilege of all matches wins (ROLE_PRIVILEGE_ORDER), in any
 * order. Restricting someone means not assigning the higher role.
 *
 * Who owns a user's role is per user (roleSource): null or 'manual' means
 * the intranet (every account that existed before, and every account an
 * admin re-roled), 'entra' means the sign-in keeps it in sync. An unknown
 * result (a Graph failure) never changes a role, so a 403, 429 or timeout
 * can never demote anyone.
 */
import { ROLE_PRIVILEGE_ORDER, type RoleType } from "../bootstrap/roles";
import {
  APP_ROLE_TABLE,
  type EntraDefaultRole,
  type EntraGroupRule,
  type EntraSyncMode,
} from "./config";
import type { GraphMe, GraphResult } from "./graph";

export type RoleResolution =
  | { kind: "role"; role: RoleType; via: string[] }
  | { kind: "deny" }
  | { kind: "unknown" };

export interface RoleResolutionInput {
  /** The `roles` claim of the verified ID token. */
  claimRoles: readonly string[];
  /** GET /me; only userType is read here. */
  me: GraphResult<Pick<GraphMe, "userType">>;
  /** checkMemberGroups; null when ENTRA_GROUP_ROLES is empty (not asked). */
  groups: GraphResult<readonly string[]> | null;
  groupRules: readonly EntraGroupRule[];
  defaultRole: EntraDefaultRole;
}

const privilegeRank = (role: RoleType) => ROLE_PRIVILEGE_ORDER.indexOf(role);

/** Spec H, rules 1-5 in order. */
export function resolveEntraRole(input: RoleResolutionInput): RoleResolution {
  const external: boolean | "unknown" = input.me.ok
    ? input.me.data.userType === "Guest"
    : "unknown";
  const groupsConfigured = input.groupRules.length > 0;

  const matches: { role: RoleType; via: string }[] = [];
  for (const claim of input.claimRoles) {
    const role = Object.prototype.hasOwnProperty.call(APP_ROLE_TABLE, claim)
      ? APP_ROLE_TABLE[claim]
      : undefined;
    if (role) matches.push({ role, via: `approle:${claim}` });
  }
  if (input.groups?.ok) {
    const memberOf = new Set(input.groups.data.map((id) => id.toLowerCase()));
    for (const rule of input.groupRules) {
      if (memberOf.has(rule.groupId))
        matches.push({ role: rule.role, via: `group:${rule.groupId}` });
    }
  }

  // 1. A configured group check that failed: the groups could have granted
  //    more (or, for a new user, anything), so nothing is decided.
  if (groupsConfigured && !input.groups?.ok) return { kind: "unknown" };
  // 2. The highest privilege of every match.
  if (matches.length > 0) {
    const role = matches.reduce(
      (best, match) => (privilegeRank(match.role) < privilegeRank(best) ? match.role : best),
      matches[0].role,
    );
    const via = [...new Set(matches.filter((match) => match.role === role).map((m) => m.via))];
    return { kind: "role", role, via };
  }
  // 3. B2B guests without an assignment never get in (assign Intranet.Guest).
  if (external === true) return { kind: "deny" };
  // 4. Member or guest cannot be told without /me.
  if (external === "unknown") return { kind: "unknown" };
  // 5. Tenant members without a match.
  if (input.defaultRole === "deny") return { kind: "deny" };
  return { kind: "role", role: input.defaultRole, via: ["default"] };
}

/** The role fields of an existing user row. */
export interface UserRoleState {
  /** The current role's type (null without a role). */
  roleType: string | null;
  roleSource: string | null;
  entraAppliedRole: string | null;
}

/** The highest role dry-run creates a new user with. */
export const DRY_RUN_ROLE_CAP: RoleType = "member";

export type RoleWriteDecision =
  /** Refuse the sign-in. */
  | { kind: "reject"; status: 403; error: "not_assigned"; audit: string }
  | { kind: "reject"; status: 503; error: "unavailable"; audit: string }
  /** New user: create with this role (roleSource 'entra', entraAppliedRole = role). */
  | { kind: "create"; role: RoleType; audit: string }
  /** Existing user: write these fields (and the role when `role` is set). */
  | {
      kind: "update";
      data: { role?: RoleType; entraAppliedRole?: RoleType | null; roleSource?: "manual" };
      audit: string;
    }
  /** Existing user: no role field changes. */
  | { kind: "keep"; audit: string };

const capForDryRun = (role: RoleType): RoleType =>
  privilegeRank(role) < privilegeRank(DRY_RUN_ROLE_CAP) ? DRY_RUN_ROLE_CAP : role;

/**
 * Spec I. `user` is null for a new identity. `audit` is the role= field of
 * the audit line (keep, a->b, would a->b, manual, manual-override, ...).
 */
export function decideRoleWrite(
  user: UserRoleState | null,
  result: RoleResolution,
  mode: EntraSyncMode,
): RoleWriteDecision {
  if (user === null) {
    if (result.kind === "unknown") {
      return { kind: "reject", status: 503, error: "unavailable", audit: "-" };
    }
    if (result.kind === "deny")
      return { kind: "reject", status: 403, error: "not_assigned", audit: "-" };
    if (mode === "on") return { kind: "create", role: result.role, audit: `new->${result.role}` };
    // Dry-run never grants more than member from Entra; guest stays guest.
    const capped = capForDryRun(result.role);
    return {
      kind: "create",
      role: capped,
      audit: capped === result.role ? `new->${capped}` : `new->${capped} would new->${result.role}`,
    };
  }

  // The intranet owns this role (every pre-existing account, every override).
  if (user.roleSource !== "entra") return { kind: "keep", audit: "manual" };

  const current = user.roleType ?? "none";
  // An admin changed the role since Entra last wrote it: the admin wins, and
  // the user becomes manual (in dry-run only logged).
  if (user.entraAppliedRole !== null && user.entraAppliedRole !== user.roleType) {
    if (mode === "dry-run") return { kind: "keep", audit: "would manual-override" };
    return {
      kind: "update",
      data: { roleSource: "manual", entraAppliedRole: null },
      audit: "manual-override",
    };
  }
  if (result.kind === "unknown") return { kind: "keep", audit: "keep" };
  if (result.kind === "deny")
    return { kind: "reject", status: 403, error: "not_assigned", audit: "keep" };

  const target = result.role;
  if (mode === "dry-run") {
    return { kind: "keep", audit: current === target ? "keep" : `would ${current}->${target}` };
  }
  if (current !== target) {
    return {
      kind: "update",
      data: { role: target, entraAppliedRole: target },
      audit: `${current}->${target}`,
    };
  }
  // Already right; record it (after a hand-back entraAppliedRole is null).
  if (user.entraAppliedRole !== target) {
    return { kind: "update", data: { entraAppliedRole: target }, audit: "keep" };
  }
  return { kind: "keep", audit: "keep" };
}
