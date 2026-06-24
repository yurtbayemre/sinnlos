/**
 * Maps Microsoft Entra ID group object IDs (or names) to Strapi role types.
 *
 * This file can be edited without a redeploy (mount it as a config volume
 * or bake it into the image). Order matters — the first match wins.
 *
 * Strapi role "type" values are lowercase identifiers. The bootstrap script
 * in src/index.ts guarantees that all five roles below exist.
 */
export type StrapiRoleType =
  | "admin_role"
  | "editor"
  | "department_head"
  | "team_lead"
  | "member"
  | "guest";

export interface MsRoleRule {
  /** Entra group objectId OR displayName (case-insensitive). */
  group: string;
  /** Target Strapi role type. */
  role: StrapiRoleType;
}

const rules: MsRoleRule[] = [
  { group: "Intranet-Admins", role: "admin_role" },
  { group: "Intranet-Editors", role: "editor" },
  { group: "Department-Heads", role: "department_head" },
  { group: "Team-Leads", role: "team_lead" },
];

/** Default role if no group matches. */
export const DEFAULT_ROLE: StrapiRoleType = "member";

/** A single Entra group as returned by Microsoft Graph `/me/memberOf`. */
export interface MsGroup {
  id?: string;
  displayName?: string;
}

/**
 * Pure Entra-group → Strapi-role resolution. Given the caller's group
 * memberships, returns the first matching rule's role (case-insensitive,
 * matching on either the group objectId or displayName) or {@link DEFAULT_ROLE}
 * when nothing matches.
 *
 * This is the authorization boundary that decides every Microsoft login's
 * Strapi role, so it is kept side-effect-free and unit-tested.
 */
export function resolveRoleType(
  groups: ReadonlyArray<MsGroup> | null | undefined,
): StrapiRoleType {
  const needle = new Set<string>();
  for (const g of groups ?? []) {
    if (g.id) needle.add(g.id.toLowerCase());
    if (g.displayName) needle.add(g.displayName.toLowerCase());
  }
  for (const rule of rules) {
    if (needle.has(rule.group.toLowerCase())) return rule.role;
  }
  return DEFAULT_ROLE;
}

export default rules;
