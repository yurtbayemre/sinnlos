/**
 * Self-service profile endpoints. The generic users-permissions
 * `user.update` permission is deliberately NOT granted to end users —
 * it would let them change anyone's role. These routes whitelist the
 * editable fields and force the target to be the caller.
 *
 * OUTPUT IS AN ALLOWLIST (FX02). Both handlers read via strapi.db.query and
 * answer via ctx.send, which means:
 *   - the DB layer returns EVERY column, schema-`private` ones included
 *     (@strapi/database 5.49 never filters `private`; entity-manager
 *     index.js:1222 is a TODO), and
 *   - ctx.send bypasses the content-api output sanitizer (issue #10).
 * The former top-level 3-key denylist (password/resetPasswordToken/
 * confirmationToken) therefore let the POPULATED manager — a different
 * user — carry their bcrypt hash, reset/confirmation tokens, birthday with
 * year (regardless of birthdayVisible) and lastDigestAt to every caller.
 *
 * Now every key in the response is named explicitly:
 *   - `toSelfProfile` — the caller's OWN record, including the
 *     schema-`private` fields that must never appear on /api/users for
 *     other people (birthday, birthdayVisible, lastDigestAt — the latter is
 *     readable here but never writable, see EDITABLE_FIELDS).
 *   - `toManagerSummary` — the manager is a FOREIGN user: identity + job
 *     title only, plus contact fields for exactly the roles the #10
 *     sanitizer lets read them (`shouldSanitizeForRole`, F3). The manager
 *     populate additionally carries an explicit `select`, so the private
 *     columns are never even loaded.
 * A new column on the user model is therefore invisible here until someone
 * adds it to an allowlist on purpose.
 */
import {
  SENSITIVE_USER_FIELDS,
  USER_UID,
  shouldSanitizeForRole,
} from "../../../utils/sanitize-user-contact";

const EDITABLE_FIELDS = [
  "displayName",
  "jobTitle",
  "phone",
  "officeLocation",
  "locale",
  "birthday",
  "birthdayVisible",
  // E-mail digest opt-ins (issue #18) — booleans + frequency, coerced and
  // validated in updateMe below. `lastDigestAt` is deliberately NOT here:
  // it is cron-owned state, private on the schema.
  "digestAnnouncements",
  "digestMentions",
  "digestKudos",
  "digestFrequency",
] as const;

/**
 * The caller's own scalar fields returned by GET/PUT /api/me. Never add
 * password, resetPasswordToken or confirmationToken. The web profile page
 * reads username/email/displayName/avatar and the form fields
 * (apps/web/src/app/(app)/profile/page.tsx).
 */
export const SELF_PROFILE_FIELDS = [
  "id",
  "documentId",
  "username",
  "email",
  "provider",
  "confirmed",
  "blocked",
  "displayName",
  "jobTitle",
  "phone",
  "officeLocation",
  "hireDate",
  "locale",
  "birthday",
  "birthdayVisible",
  "digestAnnouncements",
  "digestMentions",
  "digestKudos",
  "digestFrequency",
  "lastDigestAt",
  "createdAt",
  "updatedAt",
] as const;

/** Relations on the caller's own row: summaries, never the raw rows. */
const ROLE_SUMMARY_FIELDS = ["id", "documentId", "name", "type"] as const;
const DEPARTMENT_SUMMARY_FIELDS = ["id", "documentId", "name", "slug"] as const;
/** What avatarThumbUrl() and <AvatarImage> need (apps/web/src/lib/config.ts). */
const AVATAR_FIELDS = [
  "id",
  "documentId",
  "name",
  "alternativeText",
  "width",
  "height",
  "formats",
  "url",
  "mime",
] as const;

/** Manager fields every caller may see. */
export const MANAGER_SUMMARY_FIELDS = [
  "id",
  "documentId",
  "username",
  "displayName",
  "jobTitle",
] as const;

/**
 * Manager contact fields, only for PRIVILEGED_ROLE_TYPES (#10 / F3). A
 * subset of SENSITIVE_USER_FIELDS (enforced by `satisfies`); hireDate and
 * microsoftOid are not contact data and stay out even for privileged
 * callers — the /api/users directory remains the place for them.
 */
export const MANAGER_CONTACT_FIELDS = [
  "email",
  "phone",
  "officeLocation",
] as const satisfies readonly (typeof SENSITIVE_USER_FIELDS)[number][];

type Row = Record<string, unknown>;
type RoleType = string | null | undefined;

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Object.hasOwn is ES2022; the Strapi server tsconfig targets ES2020 libs.
function has(row: Row, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

/** Copy only the named OWN keys; absent keys stay absent. */
function pick(row: Row, fields: readonly string[]): Row {
  const out: Row = {};
  for (const field of fields) {
    if (has(row, field)) out[field] = row[field];
  }
  return out;
}

/** Populated relation → allowlisted summary; unset/unpopulated → null. */
function pickRelation(value: unknown, fields: readonly string[]): Row | null {
  return isRow(value) ? pick(value, fields) : null;
}

/** Columns loaded for the manager populate (and the only ones returned). */
export function managerFields(callerRoleType: RoleType): string[] {
  return shouldSanitizeForRole(callerRoleType)
    ? [...MANAGER_SUMMARY_FIELDS]
    : [...MANAGER_SUMMARY_FIELDS, ...MANAGER_CONTACT_FIELDS];
}

/**
 * The caller's manager as a foreign-user summary. Contact fields only for
 * privileged callers; fail-closed for guest / authenticated / unknown roles.
 */
export function toManagerSummary(row: unknown, callerRoleType: RoleType): Row | null {
  return isRow(row) ? pick(row, managerFields(callerRoleType)) : null;
}

/**
 * The caller's OWN record: allowlisted scalars plus role/department/avatar
 * summaries. `manager` is a foreign user and deliberately NOT handled here
 * (see toManagerSummary).
 */
export function toSelfProfile(row: Row): Row {
  const out = pick(row, SELF_PROFILE_FIELDS);
  if (has(row, "role")) out.role = pickRelation(row.role, ROLE_SUMMARY_FIELDS);
  if (has(row, "department")) {
    out.department = pickRelation(row.department, DEPARTMENT_SUMMARY_FIELDS);
  }
  if (has(row, "avatar")) out.avatar = pickRelation(row.avatar, AVATAR_FIELDS);
  return out;
}

/**
 * Shared read for GET and PUT: always the caller's own id (never from the
 * request), manager loaded through an explicit select.
 */
async function loadProfile(userId: number, callerRoleType: RoleType): Promise<Row | null> {
  const full: unknown = await strapi.db.query(USER_UID).findOne({
    where: { id: userId },
    populate: {
      role: true,
      department: true,
      avatar: true,
      manager: { select: managerFields(callerRoleType) },
    },
  });
  if (!isRow(full)) return null;
  return {
    ...toSelfProfile(full),
    manager: toManagerSummary(full.manager, callerRoleType),
  };
}

/** The slice of the Koa context these handlers use. */
export interface ProfileContext {
  state: { user?: { id: number; role?: { type?: string | null } | null } | null };
  request: { body?: unknown };
  send(body: unknown): unknown;
  unauthorized(): unknown;
  notFound(): unknown;
  badRequest(message: string): unknown;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async me(ctx: ProfileContext) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const profile = await loadProfile(user.id, user.role?.type);
    if (!profile) return ctx.notFound();
    return ctx.send({ data: profile });
  },

  async updateMe(ctx: ProfileContext) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const raw = ctx.request.body;
    const body = isRow(raw) && isRow(raw.data) ? raw.data : isRow(raw) ? raw : {};
    const data: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in body) data[field] = body[field];
    }
    if (Object.keys(data).length === 0) return ctx.badRequest("No editable fields provided");

    // Normalize the birthday fields: empty string clears the date, anything
    // else must be a plain ISO date; the visibility flag is coerced to boolean
    // so form-encoded values ("on"/"true") behave predictably.
    if ("birthday" in data) {
      if (data.birthday === "" || data.birthday === null) {
        data.birthday = null;
      } else if (typeof data.birthday !== "string" || !ISO_DATE.test(data.birthday)) {
        return ctx.badRequest("birthday must be a YYYY-MM-DD date or null");
      } else {
        // The regex alone accepts impossible calendar dates (2026-02-31),
        // which Postgres rejects with a 500 at insert time. Roundtrip
        // through Date: ISO date-only strings parse as UTC midnight, so a
        // real date survives toISOString() unchanged, while an overflowing
        // one normalizes to a different day (2026-02-31 → 2026-03-03) and
        // an impossible month/day yields Invalid Date.
        const parsed = new Date(data.birthday);
        if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== data.birthday) {
          return ctx.badRequest("birthday must be a valid calendar date");
        }
      }
    }
    if ("birthdayVisible" in data) {
      data.birthdayVisible =
        data.birthdayVisible === true || data.birthdayVisible === "true" || data.birthdayVisible === "on";
    }
    // Digest opt-ins: same boolean coercion as birthdayVisible; the
    // frequency must be one of the schema enum values.
    for (const flag of ["digestAnnouncements", "digestMentions", "digestKudos"] as const) {
      if (flag in data) {
        data[flag] = data[flag] === true || data[flag] === "true" || data[flag] === "on";
      }
    }
    if ("digestFrequency" in data && !["daily", "weekly"].includes(data.digestFrequency as string)) {
      return ctx.badRequest("digestFrequency must be daily or weekly");
    }

    await strapi.db.query(USER_UID).update({
      where: { id: user.id },
      data,
    });

    // Same allowlisted shape as GET (FX02): own record + manager summary.
    const profile = await loadProfile(user.id, user.role?.type);
    if (!profile) return ctx.notFound();
    return ctx.send({ data: profile });
  },
};
