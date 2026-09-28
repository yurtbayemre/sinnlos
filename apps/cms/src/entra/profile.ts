/**
 * The Entra-owned profile of a user (D-ENTRA-01 spec J). Pure: what to
 * write, decided from Graph's /me and manager answers; entra/provision.ts
 * does the reads and writes, each in its own statement and try/catch.
 *
 * Source of truth, for users bound to Entra (entraTenantId set):
 *   - displayName: Entra, only ever overwritten with a non-empty value;
 *   - jobTitle, officeLocation, phone (= businessPhones[0]): Entra, mirrored
 *     exactly, so null clears them. Self-service cannot edit these four
 *     (PUT /api/me drops them, GET /api/me lists them in
 *     entraManagedFields);
 *   - email: Entra for rows the exchange created (provider 'microsoft'); an
 *     address another row already uses is not taken (logged, old value
 *     kept). An admin-bound local account keeps its own address;
 *   - department (ENTRA_SYNC_DEPARTMENT=1): the one published department
 *     whose name equals Graph's value case-insensitively; none, several or
 *     an empty value clear it, so access does not survive a move;
 *   - manager (ENTRA_SYNC_MANAGER=1): the provisioned user with that object
 *     id, or pending (entraManagerOid kept, back-filled when the manager
 *     signs in for the first time). Managers grant no permissions.
 * Nothing is applied without a successful /me. The four texts are cut to
 * USER_TEXT_MAX (Entra allows a 256-character displayName, the column takes
 * 255).
 */
import type { GraphMe, GraphResult } from "./graph";

/** The fields PUT /api/me refuses for a user bound to Entra. */
export const ENTRA_MANAGED_PROFILE_FIELDS = [
  "displayName",
  "jobTitle",
  "phone",
  "officeLocation",
] as const;

export type EntraManagedField = (typeof ENTRA_MANAGED_PROFILE_FIELDS)[number];

/** True for a row the Entra exchange owns the profile of. */
export function isEntraBound(row: { entraTenantId?: unknown } | null | undefined): boolean {
  return typeof row?.entraTenantId === "string" && row.entraTenantId.trim() !== "";
}

/**
 * The longest profile text the users table takes: displayName, jobTitle,
 * officeLocation and phone are `string` attributes, varchar(255) on
 * Postgres, and db.query writes skip Strapi's validation, so a longer value
 * fails the whole INSERT or UPDATE (a new user could never sign in, an
 * existing one never got a profile sync). Counted in code points, as
 * Postgres counts characters. Equal to PROFILE_TEXT_MAX of PUT /api/me
 * (pinned in profile.test.ts).
 */
export const USER_TEXT_MAX = 255;

/** `value` cut to USER_TEXT_MAX code points (then trimmed at the end). */
export function capUserText(value: string): string {
  const points = Array.from(value);
  if (points.length <= USER_TEXT_MAX) return value;
  return points.slice(0, USER_TEXT_MAX).join("").trimEnd();
}

export interface ProfileScalars {
  displayName?: string;
  jobTitle: string | null;
  officeLocation: string | null;
  phone: string | null;
}

/** Graph's strings as stored: trimmed, empty means unset. */
const clean = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** A profile text as stored: clean(), at most USER_TEXT_MAX code points. */
const cleanText = (value: string | null): string | null => {
  const cleaned = clean(value);
  return cleaned === null ? null : capUserText(cleaned);
};

/** The scalar fields to write from /me. */
export function buildProfileUpdate(me: GraphMe): ProfileScalars {
  const update: ProfileScalars = {
    jobTitle: cleanText(me.jobTitle),
    officeLocation: cleanText(me.officeLocation),
    phone: cleanText(me.businessPhones[0] ?? null),
  };
  const displayName = cleanText(me.displayName);
  if (displayName !== null) update.displayName = displayName;
  return update;
}

/**
 * The e-mail address /me gives a row the exchange created (provider
 * 'microsoft'): lower(mail ?? userPrincipalName). null for every other row,
 * and when Graph has neither.
 */
export function syncedEmail(me: GraphMe, provider: string | null | undefined): string | null {
  if (provider !== "microsoft") return null;
  return clean(me.mail ?? me.userPrincipalName)?.toLowerCase() ?? null;
}

export type EmailSync =
  | { kind: "set"; email: string }
  | { kind: "keep"; reason: "not-synced" | "unchanged" | "conflict" };

/**
 * Whether to write the synced address: not when there is none, when it is
 * already stored, or when another row uses it (`takenByOther`, checked
 * case-insensitively by the caller).
 */
export function decideEmailSync(
  candidate: string | null,
  current: string | null | undefined,
  takenByOther: boolean,
): EmailSync {
  if (candidate === null) return { kind: "keep", reason: "not-synced" };
  if (candidate === (current ?? "").toLowerCase()) return { kind: "keep", reason: "unchanged" };
  if (takenByOther) return { kind: "keep", reason: "conflict" };
  return { kind: "set", email: candidate };
}

/**
 * The e-mail of a NEW identity (spec F): lower(me.mail ?? claims.email ??
 * me.userPrincipalName ?? claims.preferred_username), with /me only when it
 * answered.
 */
export function newIdentityEmail(
  me: GraphMe | null,
  claims: { email: string | null; preferredUsername: string | null },
): string | null {
  const candidates = [
    me?.mail ?? null,
    claims.email,
    me?.userPrincipalName ?? null,
    claims.preferredUsername,
  ];
  for (const candidate of candidates) {
    const value = clean(candidate);
    if (value !== null) return value.toLowerCase();
  }
  return null;
}

/** The department name to look up, or null (an empty value clears the department). */
export function departmentName(me: GraphMe): string | null {
  return clean(me.department);
}

export type DepartmentTarget =
  | { kind: "set"; documentId: string }
  | { kind: "clear"; reason: "empty" | "no-match" | "ambiguous" };

/** Exactly one published match links it; none or several clear the department. */
export function pickDepartment(
  name: string | null,
  matches: readonly { documentId: string }[],
): DepartmentTarget {
  if (name === null) return { kind: "clear", reason: "empty" };
  const ids = [...new Set(matches.map((match) => match.documentId))];
  if (ids.length === 1) return { kind: "set", documentId: ids[0] };
  return { kind: "clear", reason: ids.length === 0 ? "no-match" : "ambiguous" };
}

export type ManagerSync =
  | { kind: "set"; managerOid: string }
  | { kind: "clear" }
  | { kind: "keep" };

/** 200: the manager's oid; 404: none; anything else keeps both fields. */
export function decideManagerSync(result: GraphResult<string | null>): ManagerSync {
  if (result.ok === false) return { kind: "keep" };
  return result.data === null ? { kind: "clear" } : { kind: "set", managerOid: result.data };
}

/**
 * The users whose pending manager is the user (tid, oid) that just signed
 * in: they get this user as manager (the back-fill).
 */
export function managerBackfillWhere(tenantId: string, oid: string): Record<string, unknown> {
  return { entraTenantId: tenantId, entraManagerOid: oid };
}
