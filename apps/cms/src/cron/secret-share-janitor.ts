import { SECRET_SHARE_RETENTION_MS } from "@sinnlos/domain";

import {
  SECRET_SHARE_UID,
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
 *   2. pending with a party that is not eligible (blocked, or no staff role
 *      any more) -> `cancelled`;
 *      both through the conditional end of utils/secret-shares.ts (envelope
 *      NULL, terminalAt, the notification deleted), one share per
 *      transaction with its row locked and the rule re-checked on a fresh
 *      read, so a reveal or revoke that won the row is left alone;
 *   3. shares whose sender or recipient no longer exists (a user deleted in
 *      the Content Manager), in every state, deleted with their
 *      notifications;
 *   4. ended shares whose terminalAt is older than SECRET_SHARE_RETENTION_MS
 *      (7 days), deleted.
 * Each step takes at most BATCH rows per run; the next minute continues.
 * A failing share is reported to the run and skipped. One summary line
 * when anything changed.
 */

/** Rows per step and run. */
export const BATCH = 200;

/** Rows per read. */
const PAGE = 500;

const USER_UID = "plugin::users-permissions.user";

type Row = Record<string, unknown>;

/** The slice of the Strapi instance the janitor uses. */
export type SecretShareJanitorStrapi = SecretShareHost & {
  log: { info(message: string): void };
};

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The people of `ids` with their role, by id. */
async function people(strapi: SecretShareHost, ids: unknown[]): Promise<Map<unknown, Row>> {
  if (ids.length === 0) return new Map();
  const found = rows(
    await strapi.db.query(USER_UID).findMany({
      where: { id: { $in: [...new Set(ids)] } },
      select: ["id", "blocked"],
      populate: { role: { select: ["type"] } },
    }),
  );
  return new Map(found.map((row) => [row.id, row]));
}

interface DistinctQuery {
  distinct(column: string): Promise<Row[]>;
}

/** The sender and recipient ids of every share that name no existing account. */
async function missingPeople(strapi: SecretShareHost): Promise<number[]> {
  const meta = strapi.db.metadata.get(SECRET_SHARE_UID);
  const ids = new Set<number>();
  for (const [attribute, fallback] of [
    ["senderId", "sender_id"],
    ["recipientId", "recipient_id"],
  ]) {
    const column = meta.attributes[attribute]?.columnName ?? fallback;
    const table = strapi.db.getConnection(meta.tableName) as unknown as DistinctQuery;
    for (const row of await table.distinct(column)) {
      const id = Number(row[column]);
      if (Number.isInteger(id)) ids.add(id);
    }
  }
  const all = [...ids];
  const missing: number[] = [];
  for (let start = 0; start < all.length; start += PAGE) {
    const slice = all.slice(start, start + PAGE);
    const found = await people(strapi, slice);
    missing.push(...slice.filter((id) => !found.has(id)));
  }
  return missing;
}

/**
 * Ends one pending share if `due` still holds on a fresh read under the
 * share's lock. True when it ended.
 */
async function endIfDue(
  strapi: SecretShareHost,
  id: number,
  to: "expired" | "cancelled",
  due: (share: Row, now: Date) => Promise<boolean>,
): Promise<boolean> {
  return strapi.db.transaction(async ({ trx }) => {
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
}

async function endEach(
  strapi: SecretShareHost,
  ids: number[],
  to: "expired" | "cancelled",
  due: (share: Row, now: Date) => Promise<boolean>,
): Promise<number> {
  let ended = 0;
  for (const id of ids) {
    try {
      if (await endIfDue(strapi, id, to, due)) ended += 1;
    } catch (err) {
      reportRunFailure(err, `share ${id} not ${to}`);
    }
  }
  return ended;
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

  // 1. Expired.
  const expiredIds = rows(
    await shares.findMany({
      where: { state: "pending", expiresAt: { $lte: now } },
      select: ["id"],
      orderBy: [{ id: "asc" }],
      limit: BATCH,
    }),
  ).map((row) => row.id as number);
  const expired = await endEach(strapi, expiredIds, "expired", async (share, at) =>
    isPast(share.expiresAt, at),
  );

  // 2. A party not eligible any more (existing, but blocked or without a
  // staff role). Pending shares are few (the pending caps), read in pages.
  const ineligible: number[] = [];
  for (let afterId = 0; ineligible.length < BATCH;) {
    const page = rows(
      await shares.findMany({
        where: { state: "pending", id: { $gt: afterId } },
        select: ["id", "senderId", "recipientId"],
        orderBy: [{ id: "asc" }],
        limit: PAGE,
      }),
    );
    if (page.length === 0) break;
    const known = await people(
      strapi,
      page.flatMap((share) => [share.senderId, share.recipientId]),
    );
    for (const share of page) {
      const parties = [share.senderId, share.recipientId];
      if (parties.some((id) => known.has(id) && !isEligible(known.get(id)))) {
        ineligible.push(share.id as number);
      }
    }
    afterId = page[page.length - 1].id as number;
  }
  const cancelled = await endEach(strapi, ineligible, "cancelled", async (share) => {
    const fresh = await people(strapi, [share.senderId, share.recipientId]);
    return [share.senderId, share.recipientId].some(
      (id) => fresh.has(id) && !isEligible(fresh.get(id)),
    );
  });

  // 3. A party that no longer exists: every state. The distinct ids are at
  // most the staff; the shares of the missing ones are read by index.
  const missing = await missingPeople(strapi);
  const orphanIds =
    missing.length === 0
      ? []
      : rows(
          await shares.findMany({
            where: { $or: [{ senderId: { $in: missing } }, { recipientId: { $in: missing } }] },
            select: ["id"],
            orderBy: [{ id: "asc" }],
            limit: BATCH,
          }),
        ).map((row) => row.id as number);
  const orphaned =
    orphanIds.length === 0
      ? 0
      : await strapi.db.transaction(() => deleteShares(strapi, { id: { $in: orphanIds } }));

  // 4. Ended past the retention.
  const removedIds = rows(
    await shares.findMany({
      where: {
        state: { $ne: "pending" },
        terminalAt: { $lt: new Date(now.getTime() - SECRET_SHARE_RETENTION_MS) },
      },
      select: ["id"],
      orderBy: [{ id: "asc" }],
      limit: BATCH,
    }),
  ).map((row) => row.id as number);
  const removed =
    removedIds.length === 0
      ? 0
      : await strapi.db.transaction(() => deleteShares(strapi, { id: { $in: removedIds } }));

  if (expired + cancelled + orphaned + removed > 0) {
    strapi.log.info(
      `[secret-share-janitor] expired ${expired}, cancelled ${cancelled}, deleted ${orphaned} of removed accounts, deleted ${removed} past retention`,
    );
  }
  return { expired, cancelled, orphaned, removed };
}
