/**
 * Set-password links (v0.27, plan-v027-rev2.md "Token flow details"): one
 * single-use token per local account for an invitation (7 days) or a
 * password reset (1 hour).
 *
 *  - The link carries `<userId>.<43 base64url chars>` (32 random bytes).
 *    The account row stores only `<purpose>:<expires epoch s>:<token
 *    version>:<sha256 hex of the random part>` in users-permissions'
 *    private `resetPasswordToken` column (the plugin's own reset routes
 *    answer 404). A new link replaces the old one.
 *  - A link is valid only while its stored string is exactly the row's,
 *    unexpired, issued at the row's current token version (a block, a
 *    password change, an MFA reset raise it), for a local account bound to
 *    no identity provider, not blocked, and its purpose fits the row: an
 *    invitation only without a password, a reset only with one.
 *  - Redeeming checks all of that and the password baseline, hashes the
 *    password the way the plugin does (user.ensureHashedPasswords: bcrypt,
 *    the model's rounds), and writes hash, cleared token and token version
 *    + 1 in ONE UPDATE of this transaction, conditional on the stored
 *    string, with the row locked (rev3 #7): a second redemption of the same
 *    link finds no token. No JWT: the person signs in afterwards (second
 *    factor included).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { errors } from "@strapi/utils";

import { USER_UID } from "../extensions/users-permissions/strapi-server";
import { recordAuditEvent, type AuditHost } from "./audit";
import { lockUserRow, versionOf, type MfaHost } from "./mfa-core";
import { passwordProblem } from "./password-rule";

export type LinkPurpose = "invite" | "reset";

export const LINK_TTL_SECONDS: Record<LinkPurpose, number> = {
  invite: 7 * 24 * 60 * 60,
  reset: 60 * 60,
};

const STORED = /^(invite|reset):(\d{1,12}):(\d{1,10}):([0-9a-f]{64})$/;
const LINK = /^(\d{1,10})\.([A-Za-z0-9_-]{43})$/;

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const set = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** A local account bound to no identity provider: the only kind that gets a password link. */
export function isLocalUnbound(row: Row): boolean {
  return (
    row.provider === "local" &&
    !set(row.entraTenantId) &&
    !set(row.microsoftOid) &&
    !set(row.oidcIssuer) &&
    !set(row.oidcSubject)
  );
}

export const LINK_SELECT = [
  "id",
  "documentId",
  "username",
  "email",
  "displayName",
  "locale",
  "provider",
  "password",
  "blocked",
  "tokenVersion",
  "resetPasswordToken",
  "entraTenantId",
  "microsoftOid",
  "oidcIssuer",
  "oidcSubject",
];

/** The purpose a link for `row` has: an invitation without a password, else a reset. */
export function linkPurpose(row: Row): LinkPurpose {
  return set(row.password) ? "reset" : "invite";
}

/**
 * Writes a new link for `row` (in the caller's transaction) and returns
 * the token for the mail. The row must be one LINK_SELECT read.
 */
export async function issueLink(
  strapi: MfaHost,
  row: Row,
  purpose: LinkPurpose,
  now: number = Date.now(),
): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS[purpose];
  const stored = `${purpose}:${expires}:${versionOf(row.tokenVersion)}:${sha256(secret)}`;
  await strapi.db
    .query(USER_UID)
    .update({ where: { id: row.id }, data: { resetPasswordToken: stored } });
  return `${String(row.id)}.${secret}`;
}

/** Whether `token` is the valid link of `row` (see the module comment). */
export function linkMatches(row: Row, token: string, now: number = Date.now()): boolean {
  const link = LINK.exec(token);
  const stored =
    typeof row.resetPasswordToken === "string" ? STORED.exec(row.resetPasswordToken) : null;
  if (!link || !stored || Number(link[1]) !== row.id) return false;
  const given = Buffer.from(sha256(link[2]), "hex");
  const expected = Buffer.from(stored[4], "hex");
  return (
    timingSafeEqual(given, expected) &&
    Number(stored[2]) > Math.floor(now / 1000) &&
    Number(stored[3]) === versionOf(row.tokenVersion) &&
    stored[1] === linkPurpose(row) &&
    isLocalUnbound(row) &&
    row.blocked !== true
  );
}

/** The user id a link names, or null when it is no link. */
export function linkUserId(token: unknown): number | null {
  const link = typeof token === "string" ? LINK.exec(token) : null;
  return link ? Number(link[1]) : null;
}

type Knex = {
  (table: string): KnexQuery;
  raw(sql: string, bindings: unknown[]): unknown;
};
type KnexQuery = {
  withSchema(schema: string): KnexQuery;
  where(column: string, value: unknown): KnexQuery;
  update(data: Row): Promise<number>;
};

type Host = MfaHost & {
  plugin(name: string): { service(name: string): unknown };
};

/** The column of `attribute` in the users table (Strapi's metadata). */
function columnOf(strapi: Host, attribute: string, fallback: string): string {
  return strapi.db.metadata.get(USER_UID).attributes[attribute]?.columnName ?? fallback;
}

/**
 * POST /api/auth/password/set: redeems `token` with `password` (see the
 * module comment). Throws a ValidationError `token_invalid` or
 * `password_<problem>`.
 */
export async function redeemLink(
  strapi: Host,
  token: unknown,
  password: unknown,
  now: number = Date.now(),
): Promise<void> {
  const invalid = () => new errors.ValidationError("token_invalid", { code: "token_invalid" });
  const id = linkUserId(token);
  if (id === null || typeof password !== "string") throw invalid();
  await strapi.db.transaction(async ({ trx }) => {
    await lockUserRow(strapi, trx, id);
    const row = await strapi.db.query(USER_UID).findOne({ where: { id }, select: LINK_SELECT });
    if (!isRecord(row) || !linkMatches(row, token as string, now)) throw invalid();
    const problem = passwordProblem(password);
    if (problem) {
      throw new errors.ValidationError(`password_${problem}`, { code: `password_${problem}` });
    }
    const purpose = linkPurpose(row);
    const users = strapi.plugin("users-permissions").service("user") as {
      ensureHashedPasswords(values: Row): Promise<Row>;
    };
    const hashed = await users.ensureHashedPasswords({ password });
    const knex = trx as unknown as Knex;
    const tokenColumn = columnOf(strapi, "resetPasswordToken", "reset_password_token");
    const versionColumn = columnOf(strapi, "tokenVersion", "token_version");
    const table = strapi.db.metadata.get(USER_UID).tableName;
    let query = knex(table);
    if (strapi.db.dialect.client === "postgres") {
      query = query.withSchema(strapi.db.getSchemaName() || "public");
    }
    const updated = await query
      .where(columnOf(strapi, "id", "id"), id)
      .where(tokenColumn, row.resetPasswordToken)
      .update({
        [columnOf(strapi, "password", "password")]: hashed.password,
        [tokenColumn]: null,
        [columnOf(strapi, "confirmed", "confirmed")]: true,
        [versionColumn]: knex.raw("COALESCE(??, 0) + 1", [versionColumn]),
        [columnOf(strapi, "updatedAt", "updated_at")]: new Date(now),
      });
    if (updated !== 1) throw invalid();
    await recordAuditEvent(strapi as unknown as AuditHost, {
      action: "update",
      targetUid: USER_UID,
      targetDocumentId: typeof row.documentId === "string" ? row.documentId : String(id),
      actorKind: "user",
      actorUserId: id,
      actorClass: null,
      source: "content-api",
      keys: ["password"],
      detail: purpose === "invite" ? "invitation accepted" : "password reset",
    });
  });
  strapi.log.info(`[auth] password set through a link: user=${id}`);
}
