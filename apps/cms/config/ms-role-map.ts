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

export default rules;
