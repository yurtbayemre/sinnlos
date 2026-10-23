/**
 * Setting up, activating and turning off the second factor of the caller's
 * own local account (v0.27, plan-v027-rev2.md "Enrollment" + rev3), behind
 * POST /api/me/mfa/setup|activate|disable (api/profile), and the admin and
 * host resets. The sign-in check and the per-request gate are in the
 * users-permissions extension; the shared pieces in utils/mfa-core.ts.
 *
 *  - setup: the cms makes the secret (20 random bytes) and seals it,
 *    together with the user, their token version and a 10-minute expiry,
 *    into `enrollment`; nothing is stored yet. The web shows the secret as
 *    a QR code;
 *  - activate: the enrollment unseals for this user at their current
 *    version, the code matches it, and the current password is right
 *    (every activation: recent credential proof, rev3 #3). Then, with the
 *    row locked and the request's token version checked against it, the
 *    sealed secret, the code's time step (no replay) and ten hashed
 *    recovery codes are stored. The answer is a JWT with `mfa: 1` at the
 *    committed version and the recovery codes, once. Not repeatable: a
 *    second activation is 409 already_enabled (no regenerate endpoint; an
 *    admin reset or infra/mfa-reset.sh, then a new enrollment);
 *  - disable: only when the role does not require it, with the password
 *    and a code; clears the state and raises the token version (every
 *    other session ends);
 *  - identity-provider sessions (am "idp") cannot set up or activate: 409
 *    idp_session (the provider owns their second factor);
 *  - an admin reset (utils/user-admin.ts) and infra/mfa-reset.sh clear the
 *    state and raise the version; the user enrolls again at the next
 *    sign-in.
 * Refusals carry `details.code` (utils/refusal.ts).
 */
import { errors } from "@strapi/utils";

import {
  bumpTokenVersion,
  issueJwtWithClaims,
  USER_UID,
  type RequestAssurance,
  type TokenVersionStrapi,
} from "../extensions/users-permissions/strapi-server";
import {
  consumeSecondFactor,
  hashRecoveryCode,
  isEnrolled,
  lockUserRow,
  MFA_CLEARED,
  newRecoveryCodes,
  roleRequiresMfa,
  sealService,
  unseal,
  versionOf,
  type MfaHost,
} from "./mfa-core";
import { refuse } from "./refusal";
import { base32Decode, matchTotp, newTotpSecret, otpauthUri } from "./totp";

/** How long a setup stays valid. */
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/** The issuer authenticator apps show next to the account. */
export const TOTP_ISSUER = "sinnlos";

type Row = Record<string, unknown>;
type Host = MfaHost & TokenVersionStrapi;

/** Who calls: the user and what their request's verified JWT said. */
export interface MfaCaller {
  userId: number;
  assurance: RequestAssurance | undefined;
}

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function loadOwn(strapi: Host, userId: number): Promise<Row> {
  const row = await strapi.db.query(USER_UID).findOne({
    where: { id: userId },
    select: ["id", "email", "username", "password", "tokenVersion", "totpEnabledAt"],
    populate: { role: { select: ["type"] } },
  });
  if (!isRecord(row)) throw new errors.UnauthorizedError("Unauthorized");
  return row;
}

async function passwordMatches(strapi: Host, password: unknown, hash: unknown): Promise<boolean> {
  if (typeof password !== "string" || password === "" || typeof hash !== "string") return false;
  const users = strapi.plugin("users-permissions").service("user") as {
    validatePassword(password: string, hash: string): Promise<boolean>;
  };
  return users.validatePassword(password, hash);
}

/** Identity-provider sessions keep their provider's second factor. */
function refuseIdpSession(caller: MfaCaller): void {
  if (caller.assurance?.am === "idp") refuse(409, "idp_session");
}

/** The locked row's version must still be the one the request's JWT was verified at (rev3 #1). */
function assertSameVersion(caller: MfaCaller, row: unknown): number {
  const tv = versionOf(isRecord(row) ? row.tokenVersion : undefined);
  if (!caller.assurance || caller.assurance.tv !== tv) {
    refuse(401, "session_outdated", "The session is out of date; sign in again");
  }
  return tv;
}

/** POST /api/me/mfa/setup. */
export async function mfaSetup(
  strapi: Host,
  caller: MfaCaller,
  now: number = Date.now(),
): Promise<{ secret: string; otpauthUri: string; enrollment: string }> {
  refuseIdpSession(caller);
  const row = await loadOwn(strapi, caller.userId);
  if (isEnrolled(row)) refuse(409, "already_enabled");
  const secret = newTotpSecret();
  const enrollment = sealService(strapi).encrypt(
    JSON.stringify({
      u: caller.userId,
      tv: versionOf(row.tokenVersion),
      s: secret,
      exp: now + ENROLLMENT_TTL_MS,
    }),
  );
  if (!enrollment) refuse(503, "mfa_unavailable", "ENCRYPTION_KEY is not configured");
  const account =
    (typeof row.email === "string" && row.email) || String(row.username ?? caller.userId);
  return { secret, otpauthUri: otpauthUri(secret, account, TOTP_ISSUER), enrollment };
}

/** The enrollment of `userId`, unsealed and checked (user, expiry, shape), or 400 enrollment_invalid. */
function openEnrollment(
  strapi: Host,
  userId: number,
  sealed: unknown,
  now: number,
): { tv: number; secret: Buffer; encoded: string } {
  const plain = unseal(sealService(strapi), sealed);
  let data: unknown = null;
  try {
    data = plain === null ? null : JSON.parse(plain);
  } catch {
    data = null;
  }
  const secret = isRecord(data) && typeof data.s === "string" ? base32Decode(data.s) : null;
  if (
    !isRecord(data) ||
    data.u !== userId ||
    typeof data.exp !== "number" ||
    data.exp <= now ||
    typeof data.tv !== "number" ||
    secret === null
  ) {
    refuse(400, "enrollment_invalid");
  }
  return { tv: data.tv as number, secret: secret as Buffer, encoded: data.s as string };
}

/** POST /api/me/mfa/activate: `{ enrollment, code, password }`. */
export async function mfaActivate(
  strapi: Host,
  caller: MfaCaller,
  body: Row,
  now: number = Date.now(),
): Promise<{ jwt: string; recoveryCodes: string[] }> {
  refuseIdpSession(caller);
  const { userId } = caller;
  const enrollment = openEnrollment(strapi, userId, body.enrollment, now);
  const row = await loadOwn(strapi, userId);
  if (!(await passwordMatches(strapi, body.password, row.password)))
    refuse(400, "password_invalid");
  const step =
    typeof body.code === "string" ? matchTotp(enrollment.secret, body.code.trim(), now) : null;
  if (step === null) refuse(400, "mfa_invalid");
  const sealed = sealService(strapi).encrypt(enrollment.encoded);
  if (!sealed) refuse(503, "mfa_unavailable", "ENCRYPTION_KEY is not configured");
  const codes = newRecoveryCodes();
  const version = await strapi.db.transaction(async ({ trx }) => {
    await lockUserRow(strapi, trx, userId);
    const current = await strapi.db
      .query(USER_UID)
      .findOne({ where: { id: userId }, select: ["id", "tokenVersion", "totpEnabledAt"] });
    if (!isRecord(current)) throw new errors.UnauthorizedError("Unauthorized");
    if (isEnrolled(current)) refuse(409, "already_enabled");
    const tv = assertSameVersion(caller, current);
    if (tv !== enrollment.tv) refuse(400, "enrollment_invalid");
    await strapi.db.query(USER_UID).update({
      where: { id: userId },
      data: {
        totpSecret: sealed,
        totpEnabledAt: new Date(now),
        totpLastStep: step,
        totpRecoveryCodes: codes.map(hashRecoveryCode),
      },
    });
    return tv;
  });
  strapi.log.info(`[mfa] enabled: user=${userId}`);
  const jwt = await issueJwtWithClaims(strapi, userId, version, { am: "pw", mfa: 1 });
  return { jwt, recoveryCodes: codes };
}

/** POST /api/me/mfa/disable: `{ code, password }`, only when the role does not require it. */
export async function mfaDisable(
  strapi: Host,
  caller: MfaCaller,
  body: Row,
): Promise<{ jwt: string }> {
  const { userId } = caller;
  const row = await loadOwn(strapi, userId);
  if (!isEnrolled(row)) refuse(400, "mfa_not_enabled");
  if (!(await passwordMatches(strapi, body.password, row.password)))
    refuse(400, "password_invalid");
  const code = typeof body.code === "string" ? body.code : "";
  const version = await strapi.db.transaction(async ({ trx }) => {
    await lockUserRow(strapi, trx, userId);
    const current = await strapi.db.query(USER_UID).findOne({
      where: { id: userId },
      select: ["id", "tokenVersion"],
      populate: { role: { select: ["type"] } },
    });
    if (roleRequiresMfa(current)) refuse(403, "mfa_required_by_role");
    const tv = assertSameVersion(caller, current);
    const consumed = await consumeSecondFactor(strapi, userId, tv, code);
    if (!consumed.ok) refuse(400, "mfa_invalid");
    await strapi.db.query(USER_UID).update({ where: { id: userId }, data: MFA_CLEARED });
    return bumpTokenVersion(strapi, userId);
  });
  strapi.log.info(`[mfa] disabled: user=${userId}`);
  return { jwt: await issueJwtWithClaims(strapi, userId, version, { am: "pw" }) };
}

/**
 * Clears the second factor of `userId` and raises their token version,
 * inside the caller's transaction (the admin reset holds the directory
 * lock), with the row locked. The next sign-in enrolls again.
 */
export async function clearMfa(
  strapi: Host,
  trx: { raw(sql: string, bindings: unknown[]): unknown },
  userId: number,
): Promise<number> {
  await lockUserRow(strapi, trx, userId);
  await strapi.db.query(USER_UID).update({ where: { id: userId }, data: MFA_CLEARED });
  return bumpTokenVersion(strapi, userId);
}
