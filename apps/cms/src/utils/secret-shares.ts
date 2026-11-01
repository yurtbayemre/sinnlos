/**
 * Secret sharing (v0.35.0, docs/plan-v035-secret-sharing.md §3; the contract
 * is @sinnlos/domain secret-share.ts): one short text from one employee to
 * one colleague, opened once by an explicit reveal, then deleted.
 *
 * ACCESS. Only the routes of api/secret-share reach the table, through the
 * query engine and knex inside transactions (no Document Service, no core
 * route). Answers are fixed DTOs built field by field; `envelope` is never
 * selected outside create, reveal and the janitor.
 *
 * PLAINTEXT. The text exists in the create request (sealed before any
 * write) and in the reveal request (opened, then handed to the caller after
 * the commit is confirmed). Only the envelope reaches the database; it is
 * written by a knex update that fires no lifecycle, and nothing here logs a
 * text, an envelope or a database error message (which can carry bindings):
 * a failure logs the action and the error's code.
 *
 * LOCKS (plan §3.4). create, reveal and revoke run in ONE transaction:
 * the directory lock (utils/user-admin.ts), then both user rows in
 * ascending id (lockUserRow), then the share row (Postgres FOR UPDATE;
 * SQLite has one writer). Under the locks the caller is read again
 * (exists, unblocked, staff, the request's token version, and the
 * second-factor gate on the fresh row, mfaDecision); create and reveal
 * read the other party too, revoke does not, so a sender can always erase.
 * A writer outside this order (the Content Manager's bulk user deletion)
 * can deadlock with it: the transaction rolls back and the answer is
 * `busy`.
 *
 * READ ONCE. reveal checks state, expiry (clock read after the locks,
 * before decrypting) and the envelope, then a conditional update
 * `pending -> retrieved` with the envelope set NULL that must change
 * exactly one row, and deletes the share's notification in the same
 * transaction. An envelope that does not open turns the share `cancelled`
 * the same way (answer `unavailable`, 410).
 *
 * COMMIT CONFIRMATION. A resolved Strapi transaction does not prove that
 * COMMIT succeeded (after-commit.engine.test.ts): knex resolves the commit
 * call and rejects only the transaction's `executionPromise`. confirmed()
 * runs the work as the outermost transaction, keeps the knex transaction it
 * was given and awaits that promise after the transaction returned; any
 * failure there answers `busy` and no text leaves. The share is then still
 * pending, or already ended (a lost acknowledgement); nothing ever sets it
 * back to pending. On SQLite a failed COMMIT can leave the connection inside
 * the transaction: the pool's validate (config/database.ts) disposes of
 * such a connection before anyone reuses it.
 *
 * NOTIFICATIONS (plan §3.7). The share's `secretShared` notification is
 * created in the creation transaction through the query engine (its live
 * ping follows the commit, utils/live-events.ts) and deleted, by type and
 * link, in every transaction that ends the share, with an explicit
 * after-commit ping.
 */
import {
  SECRET_CREATES_PER_DAY,
  SECRET_CREATES_PER_MINUTE,
  SECRET_PENDING_PER_RECIPIENT,
  SECRET_PENDING_PER_SENDER,
  SECRET_RECIPIENTS_LIMIT,
  SECRET_RECIPIENTS_QUERY_MAX,
  SECRET_SENT_MAX_PAGE,
  SECRET_SENT_PAGE_SIZE,
  SECRET_SHARED_NOTIFICATION_TYPE,
  SECRET_SHARE_REFUSALS,
  SECRET_SHARE_RETENTION_MS,
  STAFF_ROLES,
  hasRole,
  isDocumentId,
  isRowId,
  isSecretShareLifetime,
  isSecretText,
  parseRowId,
  secretShareExpiresAt,
  secretShareLink,
  type SecretShareCreated,
  type SecretShareDetail,
  type SecretShareList,
  type SecretSharePerson,
  type SecretShareRecipient,
  type SecretShareRefusal,
  type SecretShareRevoked,
  type SecretShareState,
  type SecretShareSummary,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { mfaDecision, type RequestAssurance } from "../extensions/users-permissions/strapi-server";
import { afterCommit } from "./after-commit";
import { emitLiveEvent } from "./live-events";
import { lockUserRow, mfaRequiredRoles, versionOf, type MfaHost } from "./mfa-core";
import { NOTIFICATION_UID, buildNotification } from "./notify";
import { refuse } from "./refusal";
import { openEnvelope, sealEnvelope, shareKey } from "./secret-crypto";
import { lockDirectory, type UserAdminHost } from "./user-admin";

export const SECRET_SHARE_UID = "api::secret-share.secret-share";
const USER_UID = "plugin::users-permissions.user";
const LOG = "[secrets]";

type Row = Record<string, unknown>;

interface KnexBuilder {
  where(where: Row): KnexBuilder;
  whereNull(column: string): KnexBuilder;
  whereNotNull(column: string): KnexBuilder;
  update(data: Row): Promise<number>;
  transacting(trx: unknown): KnexBuilder;
}

/** The slice of the Strapi instance this module uses. */
export interface SecretShareHost {
  db: {
    query(uid: string): {
      findOne(params: Row): Promise<unknown>;
      findMany(params: Row): Promise<unknown>;
      count(params: Row): Promise<number>;
      create(params: { data: Row }): Promise<unknown>;
      deleteMany(params: Row): Promise<unknown>;
    };
    transaction<T>(callback: (scope: { trx: KnexTrx }) => Promise<T>): Promise<T>;
    inTransaction(): boolean;
    getConnection(table: string): KnexBuilder;
    dialect: { client: string };
    getSchemaName(): string | undefined | null;
    metadata: {
      get(uid: string): {
        tableName: string;
        attributes: Record<string, { columnName?: string } | undefined>;
      };
    };
  };
  log: { warn(message: string): void };
}

/** The knex transaction a Strapi transaction callback receives. */
interface KnexTrx {
  raw(sql: string, bindings: readonly unknown[]): unknown;
  executionPromise?: Promise<unknown>;
}

/** Who calls: the user row id and what the request's verified JWT said. */
export interface SecretCaller {
  userId: number;
  assurance: RequestAssurance | undefined;
}

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Epoch milliseconds of a datetime as either engine returns it (Date, ISO string, epoch number). */
function msOf(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value !== "") {
    const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** A refusal of the contract (status and code by cause, @sinnlos/domain SECRET_SHARE_REFUSALS). */
export function refuseShare(cause: SecretShareRefusal): never {
  const { status, code } = SECRET_SHARE_REFUSALS[cause];
  refuse(status, code);
}

const notFound = (): never => {
  throw new errors.NotFoundError("Not Found");
};

// ---------------------------------------------------------------------------
// The create limiter: SECRET_CREATES_PER_MINUTE per sender, in this process.

const MINUTE_MS = 60_000;
/** Senders tracked at most; beyond it the least recently used one goes. */
export const LIMITER_MAX_SENDERS = 10_000;
const recentCreates = new Map<number, number[]>();

/**
 * Reserves one create of `senderId` at `now`, or false when the minute is
 * full. Synchronous: the controller calls it before its first await, so
 * parallel requests cannot all pass the check. Every attempt counts.
 */
export function reserveCreate(senderId: number, now: number = Date.now()): boolean {
  const recent = (recentCreates.get(senderId) ?? []).filter((at) => now - at < MINUTE_MS);
  recentCreates.delete(senderId);
  if (recent.length >= SECRET_CREATES_PER_MINUTE) {
    recentCreates.set(senderId, recent);
    return false;
  }
  recent.push(now);
  recentCreates.set(senderId, recent);
  // Map order is insertion order: the first key is the least recently used.
  while (recentCreates.size > LIMITER_MAX_SENDERS) {
    recentCreates.delete(recentCreates.keys().next().value as number);
  }
  return true;
}

/** Test reset of the limiter. */
export function __resetCreateLimiterForTest(): void {
  recentCreates.clear();
}

// ---------------------------------------------------------------------------
// Transactions.

/** The code a failure is logged with: a database SQLSTATE or the error's name, never its message. */
function errorCode(err: unknown): string {
  const code = isRecord(err) ? err.code : undefined;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.name : "unknown";
}

/**
 * Runs `work` as the outermost transaction and returns its result only
 * after the COMMIT is confirmed (see the module comment). A refusal of the
 * work (an ApplicationError: 404, 409, 410, …) rolls back and is answered
 * as it is; everything else, and an unconfirmed COMMIT, is `busy`.
 */
export async function confirmed<T>(
  strapi: SecretShareHost,
  action: string,
  work: (trx: KnexTrx) => Promise<T>,
): Promise<T> {
  if (strapi.db.inTransaction()) {
    throw new Error(`${LOG} ${action} must not run inside another transaction`);
  }
  let knexTrx: KnexTrx | null = null;
  let result: T;
  try {
    result = await strapi.db.transaction(async ({ trx }) => {
      knexTrx = trx;
      return work(trx);
    });
  } catch (err) {
    if (err instanceof errors.ApplicationError) throw err;
    strapi.log.warn(`${LOG} ${action} answered busy: ${errorCode(err)}`);
    return refuseShare("busy");
  }
  try {
    const execution = (knexTrx as KnexTrx | null)?.executionPromise;
    if (!execution) throw new Error("the transaction has no execution promise");
    await execution;
  } catch (err) {
    strapi.log.warn(`${LOG} ${action} answered busy: commit unconfirmed (${errorCode(err)})`);
    return refuseShare("busy");
  }
  return result;
}

interface ShareTable {
  table: string;
  id: string;
  state: string;
  envelope: string;
  terminalAt: string;
  updatedAt: string;
}

function shareTable(strapi: SecretShareHost): ShareTable {
  const meta = strapi.db.metadata.get(SECRET_SHARE_UID);
  const column = (attribute: string, fallback: string) =>
    meta.attributes[attribute]?.columnName ?? fallback;
  return {
    table: meta.tableName,
    id: column("id", "id"),
    state: column("state", "state"),
    envelope: column("envelope", "envelope"),
    terminalAt: column("terminalAt", "terminal_at"),
    updatedAt: column("updatedAt", "updated_at"),
  };
}

/** Locks the share row for the rest of the transaction (Postgres; SQLite has one writer). */
async function lockShareRow(strapi: SecretShareHost, trx: KnexTrx, id: number): Promise<void> {
  if (strapi.db.dialect.client !== "postgres") return;
  const t = shareTable(strapi);
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const schema = strapi.db.getSchemaName() || "public";
  await trx.raw(
    `SELECT 1 FROM ${quote(schema)}.${quote(t.table)} WHERE ${quote(t.id)} = ? FOR UPDATE`,
    [id],
  );
}

/**
 * Ends a pending share: `pending -> to`, envelope NULL, terminalAt now, as
 * one conditional knex update in `trx` that must change exactly one row
 * (Strapi's single-row update selects first and updates by id), then its
 * notification goes, with a ping after the commit.
 */
export async function endShare(
  strapi: SecretShareHost,
  trx: unknown,
  share: { id: number; documentId: string; recipientId: number },
  to: Exclude<SecretShareState, "pending">,
  now: Date,
): Promise<void> {
  const t = shareTable(strapi);
  const changed = await strapi.db
    .getConnection(t.table)
    .transacting(trx)
    .where({ [t.id]: share.id, [t.state]: "pending" })
    .update({ [t.state]: to, [t.envelope]: null, [t.terminalAt]: now, [t.updatedAt]: now });
  if (changed !== 1) throw new Error(`the share changed under the lock (${changed} rows)`);
  await deleteShareNotifications(strapi, [share]);
}

/** Deletes the notifications of `shares` (type and link) and pings their recipients after the commit. */
export async function deleteShareNotifications(
  strapi: SecretShareHost,
  shares: readonly { documentId: string; recipientId: number }[],
): Promise<void> {
  if (shares.length === 0) return;
  await strapi.db.query(NOTIFICATION_UID).deleteMany({
    where: {
      type: SECRET_SHARED_NOTIFICATION_TYPE,
      link: { $in: shares.map((share) => secretShareLink(share.documentId)) },
    },
  });
  for (const recipientId of new Set(shares.map((share) => share.recipientId))) {
    await afterCommit(
      strapi.db as never,
      () => emitLiveEvent({ kind: "notification", recipientId }),
      (err) => strapi.log.warn(`${LOG} post-commit ping failed: ${errorCode(err)}`),
    );
  }
}

// ---------------------------------------------------------------------------
// People.

const PERSON_SELECT = ["id", "displayName", "username", "blocked", "tokenVersion", "totpEnabledAt"];

async function loadPerson(strapi: SecretShareHost, id: number): Promise<Row | null> {
  const row = await strapi.db.query(USER_UID).findOne({
    where: { id },
    select: PERSON_SELECT,
    populate: { role: { select: ["type"] } },
  });
  return isRecord(row) ? row : null;
}

/** Eligible for secret sharing: exists, not blocked, a staff role (plan §3.5). */
export function isEligible(row: Row | null | undefined): boolean {
  return isRecord(row) && row.blocked !== true && hasRole(row as never, STAFF_ROLES);
}

const displayNameOf = (row: Row | null): string =>
  (row && (text(row.displayName)?.trim() || text(row.username))) || "";

/**
 * The fresh caller check under the locks (plan §3.4): the caller still
 * exists, is unblocked and staff, at the token version the request was
 * verified at, and the second-factor gate passes on the fresh row with the
 * request's canonical claims.
 */
async function assertFreshCaller(strapi: SecretShareHost, caller: SecretCaller): Promise<Row> {
  const row = await loadPerson(strapi, caller.userId);
  const assurance = caller.assurance;
  if (!row || row.blocked === true || !assurance || versionOf(row.tokenVersion) !== assurance.tv) {
    refuse(401, "session_outdated", "The session is out of date; sign in again");
  }
  const claims: Row = {};
  if (assurance.am === "pw" || assurance.am === "idp") claims.am = assurance.am;
  if (assurance.mfa) claims.mfa = 1;
  const decision = mfaDecision(claims, row, mfaRequiredRoles());
  if (decision === "reauth") {
    refuse(401, "session_outdated", "The session is out of date; sign in again");
  }
  if (decision === "restricted") refuse(403, "mfa_setup_required");
  if (!isEligible(row)) throw new errors.ForbiddenError("Forbidden");
  return row;
}

/** Directory lock, then both user rows in ascending id (plan §3.4). */
async function lockPeople(strapi: SecretShareHost, trx: KnexTrx, ids: number[]): Promise<void> {
  await lockDirectory(strapi as unknown as UserAdminHost);
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    await lockUserRow(strapi as unknown as MfaHost, trx, id);
  }
}

// ---------------------------------------------------------------------------
// The share row.

const SHARE_SELECT = [
  "id",
  "documentId",
  "senderId",
  "recipientId",
  "expiresAt",
  "state",
  "terminalAt",
  "createdAt",
];

interface Share {
  id: number;
  documentId: string;
  senderId: number;
  recipientId: number;
  expiresAt: number;
  state: SecretShareState;
  terminalAt: number | null;
  createdAt: number;
  envelope?: unknown;
}

function toShare(row: unknown): Share | null {
  if (!isRecord(row)) return null;
  const expiresAt = msOf(row.expiresAt);
  const createdAt = msOf(row.createdAt);
  if (
    typeof row.id !== "number" ||
    !isDocumentId(row.documentId) ||
    !isRowId(row.senderId) ||
    !isRowId(row.recipientId) ||
    expiresAt === null ||
    createdAt === null
  ) {
    return null;
  }
  return {
    id: row.id,
    documentId: row.documentId,
    senderId: row.senderId,
    recipientId: row.recipientId,
    expiresAt,
    state: row.state as SecretShareState,
    terminalAt: msOf(row.terminalAt),
    createdAt,
    envelope: row.envelope,
  };
}

async function findShare(
  strapi: SecretShareHost,
  documentId: string,
  withEnvelope = false,
): Promise<Share | null> {
  return toShare(
    await strapi.db.query(SECRET_SHARE_UID).findOne({
      where: { documentId },
      select: withEnvelope ? [...SHARE_SELECT, "envelope"] : SHARE_SELECT,
    }),
  );
}

// ---------------------------------------------------------------------------
// The actions.

/** The body of POST /api/secret-shares, checked; refuses with the first failing field. */
export function parseCreate(
  body: unknown,
  callerId: number,
): { recipient: number; text: string; lifetime: "1h" | "24h" } {
  const data = isRecord(body) && isRecord(body.data) ? body.data : isRecord(body) ? body : {};
  const keys = Object.keys(data);
  if (keys.some((key) => !["recipient", "text", "lifetime"].includes(key))) {
    throw new errors.ValidationError("Invalid key");
  }
  if (!isRowId(data.recipient) || data.recipient === callerId) refuseShare("recipient");
  if (!isSecretText(data.text)) refuseShare("text");
  if (!isSecretShareLifetime(data.lifetime)) refuseShare("lifetime");
  return { recipient: data.recipient, text: data.text, lifetime: data.lifetime };
}

/**
 * POST /api/secret-shares (plan §3.4 Create). The controller has parsed the
 * body and reserved the limiter slot.
 */
export async function createShare(
  strapi: SecretShareHost,
  caller: SecretCaller,
  input: { recipient: number; text: string; lifetime: "1h" | "24h" },
): Promise<SecretShareCreated> {
  const key = shareKey();
  if (!key) refuseShare("noKey");
  return confirmed(strapi, "create", async (trx) => {
    await lockPeople(strapi, trx, [caller.userId, input.recipient]);
    const sender = await assertFreshCaller(strapi, caller);
    if (!isEligible(await loadPerson(strapi, input.recipient))) refuseShare("recipient");

    const shares = strapi.db.query(SECRET_SHARE_UID);
    const now = new Date();
    const open = { state: "pending", expiresAt: { $gt: now } };
    if (
      (await shares.count({ where: { ...open, senderId: caller.userId } })) >=
      SECRET_PENDING_PER_SENDER
    )
      refuseShare("quota");
    if (
      (await shares.count({ where: { ...open, recipientId: input.recipient } })) >=
      SECRET_PENDING_PER_RECIPIENT
    )
      refuseShare("quota");
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (
      (await shares.count({ where: { senderId: caller.userId, createdAt: { $gt: dayAgo } } })) >=
      SECRET_CREATES_PER_DAY
    )
      refuseShare("quota");

    const expiresAt = secretShareExpiresAt(now, input.lifetime);
    // Metadata first: the additional data needs the documentId the query
    // engine generates. Nothing is visible before the commit, and reveal
    // requires an envelope.
    const created = toShare(
      await shares.create({
        data: {
          senderId: caller.userId,
          recipientId: input.recipient,
          expiresAt,
          state: "pending",
          terminalAt: null,
          envelope: null,
        },
      }),
    );
    if (!created) throw new Error("the created share has no documentId");
    const envelope = sealEnvelope(key, input.text, {
      documentId: created.documentId,
      senderId: caller.userId,
      recipientId: input.recipient,
      expiresAt,
    });
    const t = shareTable(strapi);
    const filled = await strapi.db
      .getConnection(t.table)
      .transacting(trx)
      .where({ [t.id]: created.id, [t.state]: "pending" })
      .whereNull(t.envelope)
      .update({ [t.envelope]: envelope });
    if (filled !== 1) throw new Error(`the envelope filled ${filled} rows`);
    await strapi.db.query(NOTIFICATION_UID).create({
      data: buildNotification({
        type: "secretShared",
        titleParams: { actor: displayNameOf(sender) },
        link: secretShareLink(created.documentId),
        recipient: input.recipient,
        actor: caller.userId,
      }),
    });
    return { id: created.documentId, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * POST /api/secret-shares/:id/reveal (plan §3.4 Reveal): the text, once.
 * 404 for anything but the recipient's share.
 */
export async function revealShare(
  strapi: SecretShareHost,
  caller: SecretCaller,
  documentId: unknown,
): Promise<string> {
  if (!isDocumentId(documentId)) return notFound();
  const key = shareKey();
  if (!key) refuseShare("noKey");
  const outcome = await confirmed(strapi, "reveal", async (trx) => {
    const seen = await findShare(strapi, documentId);
    if (!seen || seen.recipientId !== caller.userId) return notFound();
    await lockPeople(strapi, trx, [seen.senderId, seen.recipientId]);
    await assertFreshCaller(strapi, caller);
    await lockShareRow(strapi, trx, seen.id);
    const share = await findShare(strapi, documentId, true);
    if (!share || share.recipientId !== caller.userId) return notFound();
    const sender = await loadPerson(strapi, share.senderId);
    // A deleted sender: the janitor deletes the share; it never opens.
    if (!sender || share.state !== "pending") refuseShare("gone");
    const now = new Date();
    if (share.expiresAt <= now.getTime() || share.envelope == null) refuseShare("gone");
    if (!isEligible(sender)) refuseShare("partyIneligible");
    const plain = openEnvelope(key, share.envelope, {
      documentId: share.documentId,
      senderId: share.senderId,
      recipientId: share.recipientId,
      expiresAt: new Date(share.expiresAt),
    });
    if (plain === null) {
      await endShare(strapi, trx, share, "cancelled", now);
      return { cancelled: true as const };
    }
    await endShare(strapi, trx, share, "retrieved", now);
    return { cancelled: false as const, text: plain };
  });
  if (outcome.cancelled) {
    strapi.log.warn(`${LOG} share ${documentId} cancelled: its envelope does not open`);
    return refuseShare("cancelled");
  }
  return outcome.text;
}

/** POST /api/secret-shares/:id/revoke (plan §3.4 Revoke): the sender, while pending. */
export async function revokeShare(
  strapi: SecretShareHost,
  caller: SecretCaller,
  documentId: unknown,
): Promise<SecretShareRevoked> {
  if (!isDocumentId(documentId)) return notFound();
  return confirmed(strapi, "revoke", async (trx) => {
    const seen = await findShare(strapi, documentId);
    if (!seen || seen.senderId !== caller.userId) return notFound();
    await lockPeople(strapi, trx, [seen.senderId, seen.recipientId]);
    await assertFreshCaller(strapi, caller);
    await lockShareRow(strapi, trx, seen.id);
    const share = await findShare(strapi, documentId);
    if (!share || share.senderId !== caller.userId) return notFound();
    if (share.state !== "pending") refuseShare("gone");
    await endShare(strapi, trx, share, "revoked", new Date());
    return { id: share.documentId };
  });
}

/** The people of `ids`, by id (missing ones absent). */
async function peopleById(strapi: SecretShareHost, ids: number[]): Promise<Map<number, Row>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const found = rows(
    await strapi.db.query(USER_UID).findMany({
      where: { id: { $in: unique } },
      select: ["id", "displayName", "username", "blocked"],
      populate: { role: { select: ["type"] } },
    }),
  );
  return new Map(found.map((row) => [row.id as number, row]));
}

/** The other party as shown: the blocked-user rule keeps the name and the flag only. */
const personOf = (row: Row | undefined): SecretSharePerson | null =>
  row ? { displayName: displayNameOf(row), blocked: row.blocked === true } : null;

function summaryOf(share: Share, counterpart: Row | undefined, now: number): SecretShareSummary {
  return {
    id: share.documentId,
    counterpart: personOf(counterpart),
    createdAt: new Date(share.createdAt).toISOString(),
    expiresAt: new Date(share.expiresAt).toISOString(),
    state: share.state,
    terminalAt: share.terminalAt === null ? null : new Date(share.terminalAt).toISOString(),
    available: share.state === "pending" && share.expiresAt > now && isEligible(counterpart),
  };
}

/** Refuses every query key but `allowed` (no populate, fields, filters, sort, …). */
function onlyKeys(query: unknown, allowed: readonly string[]): Row {
  const params = isRecord(query) ? query : {};
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new errors.ValidationError("Invalid key");
  }
  return params;
}

/** GET /api/secret-shares?sentPage= (plan §3.9 list): metadata only. */
export async function listShares(
  strapi: SecretShareHost,
  callerId: number,
  query: unknown,
): Promise<SecretShareList> {
  const params = onlyKeys(query, ["sentPage"]);
  let page = 1;
  if (params.sentPage !== undefined) {
    const parsed = parseRowId(params.sentPage);
    if (parsed === null || parsed > SECRET_SENT_MAX_PAGE) {
      throw new errors.ValidationError("Invalid sentPage");
    }
    page = parsed;
  }
  const now = Date.now();
  const shares = strapi.db.query(SECRET_SHARE_UID);
  const received = rows(
    await shares.findMany({
      where: { recipientId: callerId, state: "pending", expiresAt: { $gt: new Date(now) } },
      select: SHARE_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      limit: SECRET_PENDING_PER_RECIPIENT,
    }),
  )
    .map(toShare)
    .filter((share): share is Share => share !== null);
  const sentRows = rows(
    await shares.findMany({
      where: {
        senderId: callerId,
        $or: [
          { state: "pending" },
          { terminalAt: { $gt: new Date(now - SECRET_SHARE_RETENTION_MS) } },
        ],
      },
      select: SHARE_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      offset: (page - 1) * SECRET_SENT_PAGE_SIZE,
      limit: SECRET_SENT_PAGE_SIZE + 1,
    }),
  )
    .map(toShare)
    .filter((share): share is Share => share !== null);
  const sent = sentRows.slice(0, SECRET_SENT_PAGE_SIZE);
  const people = await peopleById(strapi, [
    ...received.map((share) => share.senderId),
    ...sent.map((share) => share.recipientId),
  ]);
  return {
    // A share whose sender is not eligible now stays pending, out of the inbox.
    received: received
      .filter((share) => isEligible(people.get(share.senderId)))
      .map((share) => summaryOf(share, people.get(share.senderId), now)),
    sent: sent.map((share) => summaryOf(share, people.get(share.recipientId), now)),
    hasMore: sentRows.length > SECRET_SENT_PAGE_SIZE,
  };
}

/** GET /api/secret-shares/:id: metadata for its sender or recipient, else 404. */
export async function shareDetail(
  strapi: SecretShareHost,
  callerId: number,
  documentId: unknown,
  query: unknown,
): Promise<SecretShareDetail> {
  onlyKeys(query, []);
  if (!isDocumentId(documentId)) return notFound();
  const share = await findShare(strapi, documentId);
  if (!share || (share.senderId !== callerId && share.recipientId !== callerId)) {
    return notFound();
  }
  const direction = share.senderId === callerId ? "sent" : "received";
  const otherId = direction === "sent" ? share.recipientId : share.senderId;
  const people = await peopleById(strapi, [otherId]);
  return { ...summaryOf(share, people.get(otherId), Date.now()), direction };
}

/** GET /api/secret-shares/recipients?q=: eligible staff by name, never the caller. */
export async function shareRecipients(
  strapi: SecretShareHost,
  callerId: number,
  query: unknown,
): Promise<SecretShareRecipient[]> {
  const params = onlyKeys(query, ["q"]);
  const q = params.q === undefined ? "" : params.q;
  if (typeof q !== "string" || Array.from(q).length > SECRET_RECIPIENTS_QUERY_MAX) {
    throw new errors.ValidationError("Invalid q");
  }
  const term = q.trim();
  const found = rows(
    await strapi.db.query(USER_UID).findMany({
      where: {
        $and: [
          { id: { $ne: callerId } },
          { $or: [{ blocked: false }, { blocked: { $null: true } }] },
          { role: { type: { $in: [...STAFF_ROLES] } } },
          ...(term
            ? [{ $or: [{ displayName: { $containsi: term } }, { username: { $containsi: term } }] }]
            : []),
        ],
      },
      select: ["id", "displayName", "username", "blocked"],
      populate: { role: { select: ["type"] }, department: { select: ["name"] } },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      limit: SECRET_RECIPIENTS_LIMIT,
    }),
  );
  return found.filter(isEligible).map((row) => ({
    id: row.id as number,
    displayName: displayNameOf(row),
    department: isRecord(row.department) ? text(row.department.name) : null,
  }));
}
