/**
 * The second factor of local accounts (v0.27, deep-dive plan-v027-rev2.md):
 * the shared pieces the users-permissions extension (sign-in, the
 * per-request gate) and utils/mfa.ts (setup, activation, disable, resets)
 * both use. No import of the extension, so neither imports the other in a
 * cycle.
 *
 *  - MFA_REQUIRED_ROLES: the roles that must have a second factor (default
 *    MODERATORS: admin_role and editor; `none` = nobody, for tests), checked
 *    at boot: an unknown role name refuses the start;
 *  - the secret is stored sealed with Strapi's admin encryption service
 *    (AES-256-GCM under ENCRYPTION_KEY). A secret that does not unseal (the
 *    key changed) refuses the code and logs why; it never opens the account.
 *    Recovery codes are sha256 hashes, so they keep working then;
 *  - every check that consumes a code runs in one transaction with the user
 *    row locked (Postgres FOR UPDATE; SQLite has a single writer) and
 *    re-checks the token version the caller holds.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ROLE_PRIVILEGE_ORDER, MODERATORS, type RoleType } from "@sinnlos/domain";

import { base32Decode, base32Encode, matchTotp } from "./totp";

export const MFA_USER_UID = "plugin::users-permissions.user";

/** Recovery codes handed out per activation. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * MFA_REQUIRED_ROLES: a comma list of role types; unset or empty =
 * MODERATORS (an empty key in an .env must not turn the second factor
 * off), `none` = nobody (tests). Throws on an unknown name (register()
 * refuses the boot).
 */
export function parseMfaRequiredRoles(value: string | undefined): RoleType[] {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return [...MODERATORS];
  if (trimmed.toLowerCase() === "none") return [];
  const names = trimmed
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter(
    (name) => !(ROLE_PRIVILEGE_ORDER as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `MFA_REQUIRED_ROLES: unknown role ${unknown.join(", ")} (one of ${ROLE_PRIVILEGE_ORDER.join(", ")}; empty = nobody)`,
    );
  }
  return names as RoleType[];
}

/** The roles of this process (the env is read once per call; register() validated it). */
export function mfaRequiredRoles(
  env: Record<string, string | undefined> = process.env,
): RoleType[] {
  return parseMfaRequiredRoles(env.MFA_REQUIRED_ROLES);
}

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function roleTypeOf(user: unknown): string | null {
  const role = isRecord(user) ? user.role : undefined;
  return isRecord(role) && typeof role.type === "string" ? role.type : null;
}

/** Whether the row has an active second factor. */
export function isEnrolled(user: unknown): boolean {
  return isRecord(user) && user.totpEnabledAt !== null && user.totpEnabledAt !== undefined;
}

/** Whether the user's role requires a second factor (rev3 #2: what disable checks). */
export function roleRequiresMfa(
  user: unknown,
  roles: readonly string[] = mfaRequiredRoles(),
): boolean {
  const role = roleTypeOf(user);
  return role !== null && roles.includes(role);
}

/** Whether the user must pass a second factor: a required role, or one they turned on. */
export function requiredMfa(user: unknown, roles: readonly string[] = mfaRequiredRoles()): boolean {
  return roleRequiresMfa(user, roles) || isEnrolled(user);
}

/** A stored or claimed version: a non-negative integer, anything else is 0. */
export function versionOf(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/** Strapi's admin encryption service (AES-256-GCM under ENCRYPTION_KEY). */
export interface SealService {
  encrypt(value: string): string | null;
  decrypt(value: string): string | null;
}

export interface MfaHost {
  db: {
    query(uid: string): {
      findOne(params: Row): Promise<unknown>;
      update(params: Row): Promise<unknown>;
      updateMany(params: Row): Promise<{ count: number }>;
    };
    transaction<T>(
      callback: (scope: { trx: { raw(sql: string, b: unknown[]): unknown } }) => Promise<T>,
    ): Promise<T>;
    dialect: { client: string };
    getSchemaName(): string | undefined | null;
    metadata: {
      get(uid: string): {
        tableName: string;
        attributes: Record<string, { columnName?: string } | undefined>;
      };
    };
  };
  service(uid: string): unknown;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

/** The encryption service, or a throw (bootstrap checks it once, so a request never meets this). */
export function sealService(strapi: Pick<MfaHost, "service">): SealService {
  const service = strapi.service("admin::encryption");
  if (
    !isRecord(service) ||
    typeof service.encrypt !== "function" ||
    typeof service.decrypt !== "function"
  ) {
    throw new Error("[mfa] Strapi's admin::encryption service is missing (encrypt/decrypt)");
  }
  return service as unknown as SealService;
}

/** decrypt() that never throws: an unknown format or a wrong key is null. */
export function unseal(seal: SealService, value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return seal.decrypt(value);
  } catch {
    return null;
  }
}

/** Ten new recovery codes, `xxxxx-xxxxx` in lowercase base32 (50 bits each). */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** The stored form of a recovery code: sha256 of its normalised spelling. */
export function hashRecoveryCode(code: string): string {
  const normal = code.replace(/[\s-]/g, "").toLowerCase();
  return createHash("sha256").update(normal, "utf8").digest("hex");
}

/** A TOTP code (6 digits) or a recovery code; anything else is null. */
export function secondFactorKind(input: string): "totp" | "recovery" | null {
  const value = input.trim();
  if (/^\d{6}$/.test(value)) return "totp";
  if (/^[a-z2-7]{5}-?[a-z2-7]{5}$/i.test(value)) return "recovery";
  return null;
}

/** Locks the user row for the rest of the transaction (Postgres); SQLite has one writer anyway. */
export async function lockUserRow(
  strapi: MfaHost,
  trx: { raw(sql: string, bindings: unknown[]): unknown },
  id: number,
): Promise<void> {
  if (strapi.db.dialect.client !== "postgres") return;
  const meta = strapi.db.metadata.get(MFA_USER_UID);
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const schema = strapi.db.getSchemaName() || "public";
  const idColumn = meta.attributes.id?.columnName ?? "id";
  await trx.raw(
    `SELECT 1 FROM ${quote(schema)}.${quote(meta.tableName)} WHERE ${quote(idColumn)} = ? FOR UPDATE`,
    [id],
  );
}

export const MFA_SELECT = [
  "id",
  "tokenVersion",
  "totpSecret",
  "totpEnabledAt",
  "totpLastStep",
  "totpRecoveryCodes",
];

/** Whether `hash` is one of `codes`, compared in constant time; its index or -1. */
function indexOfHash(codes: string[], hash: string): number {
  let index = -1;
  const given = Buffer.from(hash, "hex");
  codes.forEach((code, i) => {
    const stored = Buffer.from(code, "hex");
    if (stored.length === given.length && timingSafeEqual(stored, given)) index = i;
  });
  return index;
}

/**
 * Checks and consumes one second factor of an ENROLLED user at version
 * `tv`, in one transaction with the row locked: a TOTP code must be of a
 * later step than the last one accepted (no replay), a recovery code is
 * removed from the list. False for anything else: a stale version (a
 * password change, a block, a reset since), no enrollment, a wrong code, a
 * secret that does not unseal.
 */
export async function consumeSecondFactor(
  strapi: MfaHost,
  userId: number,
  tv: number,
  input: string,
  now: number = Date.now(),
): Promise<{ ok: boolean; via?: "totp" | "recovery"; remaining?: number }> {
  const kind = secondFactorKind(input);
  if (kind === null) return { ok: false };
  return strapi.db.transaction(async ({ trx }) => {
    await lockUserRow(strapi, trx, userId);
    const users = strapi.db.query(MFA_USER_UID);
    const row = await users.findOne({ where: { id: userId }, select: MFA_SELECT });
    if (!isRecord(row) || versionOf(row.tokenVersion) !== tv || !isEnrolled(row))
      return { ok: false };
    if (kind === "totp") {
      const plain = unseal(sealService(strapi), row.totpSecret);
      const secret = plain === null ? null : base32Decode(plain);
      if (secret === null) {
        strapi.log.error(
          `[mfa] the second-factor secret of user ${userId} does not unseal (ENCRYPTION_KEY changed?); code refused, recovery codes still work`,
        );
        return { ok: false };
      }
      const step = matchTotp(secret, input.trim(), now);
      if (step === null) return { ok: false };
      // Conditional on a later step (no replay), under the lock as well (the version was checked above).
      const { count } = await users.updateMany({
        where: {
          id: userId,
          totpEnabledAt: { $notNull: true },
          $or: [{ totpLastStep: { $null: true } }, { totpLastStep: { $lt: step } }],
        },
        data: { totpLastStep: step },
      });
      return count === 1 ? { ok: true, via: "totp" } : { ok: false };
    }
    const codes = Array.isArray(row.totpRecoveryCodes)
      ? row.totpRecoveryCodes.filter((code): code is string => typeof code === "string")
      : [];
    const index = indexOfHash(codes, hashRecoveryCode(input));
    if (index < 0) return { ok: false };
    const remaining = codes.filter((_, i) => i !== index);
    await users.update({ where: { id: userId }, data: { totpRecoveryCodes: remaining } });
    strapi.log.info(`[mfa] recovery code used: user=${userId} remaining=${remaining.length}`);
    return { ok: true, via: "recovery", remaining: remaining.length };
  });
}

/** The cleared second-factor state (an admin reset, a disable, infra/mfa-reset.sh). */
export const MFA_CLEARED = {
  totpSecret: null,
  totpEnabledAt: null,
  totpLastStep: null,
  totpRecoveryCodes: null,
};
