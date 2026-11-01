import { SECRET_SHARE_RETENTION_MS, STAFF_ROLES } from "@sinnlos/domain";

import {
  SECRET_SHARE_UID,
  confirmed,
  deleteShares,
  endShare,
  isEligible,
  type SecretShareHost,
} from "../utils/secret-shares";
import { reportRunFailure } from "./run-context";

/**
 * The secret-share janitor (v0.35.0, plan §3.8), every minute, registered
 * whatever FEATURES_OFF says: it is erasure.
 *
 *   1. pending past its expiry -> `expired`;
 *   2. pending with a party that exists but is not eligible (blocked, or no
 *      staff role any more) -> `cancelled`;
 *      both through the conditional end of utils/secret-shares.ts (envelope
 *      NULL, terminalAt, the notification deleted), one share per
 *      transaction with its row locked and the rule re-checked on a fresh
 *      read, so a reveal or revoke that won the row is left alone;
 *   3. shares whose sender or recipient no longer exists (a user deleted in
 *      the Content Manager), in every state, deleted with their
 *      notifications;
 *   4. ended shares whose terminalAt is older than SECRET_SHARE_RETENTION_MS
 *      (7 days), deleted.
 * Each step selects at most BATCH candidate ids in SQL (steps 2 and 3 with
 * NOT EXISTS against the users, so nothing is walked in memory) and changes
 * at most those; the next minute continues. Every transaction runs through
 * the commit confirmation of utils/secret-shares.ts (`confirmed`): only a
 * confirmed COMMIT counts, and an unconfirmed one is reported to the run,
 * so the recorded outcome is `failed`. One summary line when anything
 * changed.
 */

/** Rows per step and run. */
export const BATCH = 200;

type Row = Record<string, unknown>;

/** The slice of the Strapi instance the janitor uses. */
export type SecretShareJanitorStrapi = SecretShareHost & {
  db: {
    connection: { raw(sql: string, bindings: readonly unknown[]): Promise<unknown> };
  };
  log: { info(message: string): void };
};

const USER_UID = "plugin::users-permissions.user";
const ROLE_UID = "plugin::users-permissions.role";

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRecord) : []);
/** Rows of a knex raw() result: an array (SQLite) or `{ rows }` (pg). */
const rawRows = (result: unknown): Row[] =>
  Array.isArray(result) ? rows(result) : rows((result as { rows?: unknown } | null)?.rows);

/** Quoted, schema-qualified (Postgres) names of the tables the candidate queries read. */
function names(strapi: SecretShareJanitorStrapi) {
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const schema =
    strapi.db.dialect.client === "postgres" ? strapi.db.getSchemaName() || "public" : null;
  const table = (name: string) => (schema ? `${quote(schema)}.${quote(name)}` : quote(name));
  const shares = strapi.db.metadata.get(SECRET_SHARE_UID);
  const users = strapi.db.metadata.get(USER_UID);
  // The relation's link table (users-permissions: up_users_role_lnk).
  const link = (
    users.attributes.role as
      | {
          joinTable?: {
            name?: string;
            joinColumn?: { name?: string };
            inverseJoinColumn?: { name?: string };
          };
        }
      | undefined
  )?.joinTable;
  if (!link?.name || !link.joinColumn?.name || !link.inverseJoinColumn?.name) {
    throw new Error("[secret-share-janitor] the users' role link table is unknown");
  }
  const col = (meta: typeof shares, attribute: string, fallback: string) =>
    quote(meta.attributes[attribute]?.columnName ?? fallback);
  return {
    shares: table(shares.tableName),
    id: col(shares, "id", "id"),
    state: col(shares, "state", "state"),
    sender: col(shares, "senderId", "sender_id"),
    recipient: col(shares, "recipientId", "recipient_id"),
    users: table(users.tableName),
    userId: col(users, "id", "id"),
    blocked: col(users, "blocked", "blocked"),
    link: table(link.name),
    linkUser: quote(link.joinColumn.name),
    linkRole: quote(link.inverseJoinColumn.name),
    roles: table(strapi.db.metadata.get(ROLE_UID).tableName),
    roleId: quote("id"),
    roleType: quote("type"),
  };
}

/** At most BATCH ids of pending shares with a party that exists and is not eligible. */
async function ineligibleIds(strapi: SecretShareJanitorStrapi): Promise<number[]> {
  const n = names(strapi);
  const staff = STAFF_ROLES.map(() => "?").join(", ");
  const exists = (party: string) =>
    `EXISTS (SELECT 1 FROM ${n.users} u WHERE u.${n.userId} = s.${party})`;
  const eligible = (party: string) =>
    `EXISTS (SELECT 1 FROM ${n.users} u JOIN ${n.link} l ON l.${n.linkUser} = u.${n.userId} ` +
    `JOIN ${n.roles} r ON r.${n.roleId} = l.${n.linkRole} WHERE u.${n.userId} = s.${party} ` +
    `AND (u.${n.blocked} IS NULL OR u.${n.blocked} = ?) AND r.${n.roleType} IN (${staff}))`;
  const result = await strapi.db.connection.raw(
    `SELECT s.${n.id} AS id FROM ${n.shares} s WHERE s.${n.state} = 'pending' AND (` +
      `(${exists(n.sender)} AND NOT ${eligible(n.sender)}) OR ` +
      `(${exists(n.recipient)} AND NOT ${eligible(n.recipient)})) ORDER BY s.${n.id} LIMIT ?`,
    [false, ...STAFF_ROLES, false, ...STAFF_ROLES, BATCH],
  );
  return rawRows(result).map((row) => Number(row.id));
}

/** At most BATCH ids of shares, in any state, whose sender or recipient no longer exists. */
async function orphanIds(strapi: SecretShareJanitorStrapi): Promise<number[]> {
  const n = names(strapi);
  const missing = (party: string) =>
    `NOT EXISTS (SELECT 1 FROM ${n.users} u WHERE u.${n.userId} = s.${party})`;
  const result = await strapi.db.connection.raw(
    `SELECT s.${n.id} AS id FROM ${n.shares} s WHERE ${missing(n.sender)} OR ${missing(n.recipient)} ` +
      `ORDER BY s.${n.id} LIMIT ?`,
    [BATCH],
  );
  return rawRows(result).map((row) => Number(row.id));
}

/** The people of `ids` with their role, by id. */
async function people(strapi: SecretShareHost, ids: unknown[]): Promise<Map<unknown, Row>> {
  const found = rows(
    await strapi.db.query(USER_UID).findMany({
      where: { id: { $in: [...new Set(ids)] } },
      select: ["id", "blocked"],
      populate: { role: { select: ["type"] } },
    }),
  );
  return new Map(found.map((row) => [row.id, row]));
}

/** Ends each share whose `due` still holds under its lock; counts the confirmed ends. */
async function endEach(
  strapi: SecretShareHost,
  ids: number[],
  to: "expired" | "cancelled",
  due: (share: Row, now: Date) => Promise<boolean>,
): Promise<number> {
  let ended = 0;
  for (const id of ids) {
    try {
      const done = await confirmed(strapi, `janitor ${to}`, async (trx) => {
        if (strapi.db.dialect.client === "postgres") {
          const meta = strapi.db.metadata.get(SECRET_SHARE_UID);
          const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
          const schema = strapi.db.getSchemaName() || "public";
          await trx.raw(
            `SELECT 1 FROM ${quote(schema)}.${quote(meta.tableName)} WHERE ${quote(meta.attributes.id?.columnName ?? "id")} = ? FOR UPDATE`,
            [id],
          );
        }
        const share = await strapi.db.query(SECRET_SHARE_UID).findOne({
          where: { id, state: "pending" },
          select: ["id", "documentId", "senderId", "recipientId", "expiresAt"],
        });
        const now = new Date();
        if (!isRecord(share) || !(await due(share, now))) return false;
        await endShare(
          strapi,
          trx,
          share as { id: number; documentId: string; recipientId: number },
          to,
          now,
        );
        return true;
      });
      if (done) ended += 1;
    } catch (err) {
      reportRunFailure(err, `share ${id} not ${to}`);
    }
  }
  return ended;
}

/** Deletes the shares of `ids` with their notifications; 0 unless the COMMIT is confirmed. */
async function deleteConfirmed(
  strapi: SecretShareHost,
  ids: number[],
  what: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    return await confirmed(strapi, `janitor ${what}`, () =>
      deleteShares(strapi, { id: { $in: ids } }),
    );
  } catch (err) {
    reportRunFailure(err, `${ids.length} share(s) ${what} not deleted`);
    return 0;
  }
}

const isPast = (value: unknown, now: Date) => {
  const ms = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return !Number.isNaN(ms) && ms <= now.getTime();
};

export async function runSecretShareJanitor(
  strapi: SecretShareJanitorStrapi,
): Promise<{ expired: number; cancelled: number; orphaned: number; removed: number }> {
  const shares = strapi.db.query(SECRET_SHARE_UID);
  const now = new Date();
  const ids = async (where: Row) =>
    rows(
      await shares.findMany({ where, select: ["id"], orderBy: [{ id: "asc" }], limit: BATCH }),
    ).map((row) => row.id as number);

  // 1. Expired.
  const expired = await endEach(
    strapi,
    await ids({ state: "pending", expiresAt: { $lte: now } }),
    "expired",
    async (share, at) => isPast(share.expiresAt, at),
  );

  // 2. A party that exists but is not eligible any more, re-checked fresh.
  const cancelled = await endEach(
    strapi,
    await ineligibleIds(strapi),
    "cancelled",
    async (share) => {
      const fresh = await people(strapi, [share.senderId, share.recipientId]);
      return [share.senderId, share.recipientId].some(
        (id) => fresh.has(id) && !isEligible(fresh.get(id)),
      );
    },
  );

  // 3. A party that no longer exists: every state.
  const orphaned = await deleteConfirmed(strapi, await orphanIds(strapi), "of removed accounts");

  // 4. Ended past the retention.
  const removed = await deleteConfirmed(
    strapi,
    await ids({
      state: { $ne: "pending" },
      terminalAt: { $lt: new Date(now.getTime() - SECRET_SHARE_RETENTION_MS) },
    }),
    "past retention",
  );

  if (expired + cancelled + orphaned + removed > 0) {
    strapi.log.info(
      `[secret-share-janitor] expired ${expired}, cancelled ${cancelled}, deleted ${orphaned} of removed accounts, deleted ${removed} past retention`,
    );
  }
  return { expired, cancelled, orphaned, removed };
}
