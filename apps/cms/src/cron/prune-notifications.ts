/**
 * Nightly retention for notifications (LF07; owner answer 2026-09-29 (b)):
 *   - a READ notification is deleted 90 days after it was read (and it is
 *     at least that old: readAt never precedes createdAt, both are checked);
 *   - an UNREAD notification never expires;
 *   - a fan-out ANCHOR row is never deleted, read or not: a notification
 *     that carries `sourceType` or `sourceDocumentId` is the dedup ledger of
 *     the announcement/event fan-out (utils/notification-source.ts, §5.26).
 *     Deleting it would make the next re-publish notify that recipient
 *     again, and would let the digest's republish check (send-digests.ts)
 *     mail an old announcement as news. So only un-anchored rows go:
 *     comment and kudos notifications, and the legacy fan-out rows from
 *     before the anchors (#12), whose one-time cleanup otherwise stays an
 *     owner step.
 *
 * Runs at 03:40 APP_TIME_ZONE, after the 03:00 host backup (registry.ts),
 * so every row it removes is still in that night's dump.
 *
 * Deletion: id pages of NOTIFICATION_PRUNE_BATCH through an id cursor, the
 * rows re-checked with the pure rule (isPrunableNotification) before their
 * ids are deleted, one `deleteMany` per page. The link rows of `recipient`
 * and `actor` go with them: Strapi's link tables reference the row with
 * ON DELETE CASCADE (@strapi/database 5.55.1 metadata/relations.js; SQLite
 * runs with foreign_keys on), pinned for both engines in
 * integration/retention.integration.test.ts. No live ping: a pruned row is
 * long read, and the bell refetches on its own schedule. At most
 * NOTIFICATION_PRUNE_MAX_BATCHES pages per run (the first night after the
 * deploy may find a backlog); the rest follows the next night.
 *
 * Errors propagate to the cron wrapper (guardedTask logs them); pages
 * deleted before the error stay deleted, which is harmless: every deleted
 * row passed the rule.
 */
import {
  UNANCHORED_NOTIFICATION_WHERE,
  isAnchoredNotification,
} from "../utils/notification-source";
import { instantMsOrNull } from "../utils/time";

/** Days a READ notification is kept after it was read (owner decision). */
export const NOTIFICATION_RETENTION_DAYS = 90;
/** Rows per read and per `deleteMany`. */
export const NOTIFICATION_PRUNE_BATCH = 500;
/** Pages per run: at most 100 000 rows a night. */
export const NOTIFICATION_PRUNE_MAX_BATCHES = 200;

const NOTIFICATION_UID = "api::notification.notification";
const DAY_MS = 86_400_000;

/** A notification row as the janitor reads it. */
export interface PruneCandidate {
  id: number;
  readAt?: unknown;
  createdAt?: unknown;
  sourceType?: unknown;
  sourceDocumentId?: unknown;
}

/** The slice of the Strapi instance the janitor uses. */
export interface NotificationJanitorStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      deleteMany(params: Record<string, unknown>): Promise<{ count?: number } | unknown>;
    };
  };
  log: { info(message: string): void };
}

/** Rows read or created before this instant are old enough. */
export function notificationPruneCutoff(
  now: Date,
  days: number = NOTIFICATION_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

const asInstantInput = (value: unknown): string | Date | null =>
  typeof value === "string" || value instanceof Date ? value : null;

/**
 * The rule (pure): read before the cutoff, created before the cutoff, and
 * no fan-out anchor. Anything unparseable is kept: deletion is the
 * irreversible arm, so this fails closed.
 */
export function isPrunableNotification(row: PruneCandidate, cutoff: Date): boolean {
  if (isAnchoredNotification(row)) return false;
  const readInput = asInstantInput(row.readAt);
  const createdInput = asInstantInput(row.createdAt);
  const readMs = readInput == null ? null : instantMsOrNull(readInput);
  const createdMs = createdInput == null ? null : instantMsOrNull(createdInput);
  if (readMs == null || createdMs == null) return false;
  const cutoffMs = cutoff.getTime();
  return readMs < cutoffMs && createdMs < cutoffMs;
}

/** The same rule as a query-engine where clause (the database's side of it). */
export function prunableNotificationWhere(cutoff: Date): Record<string, unknown> {
  const before = cutoff.toISOString();
  return {
    $and: [
      { readAt: { $notNull: true } },
      { readAt: { $lt: before } },
      { createdAt: { $lt: before } },
      UNANCHORED_NOTIFICATION_WHERE,
    ],
  };
}

const rowsOf = (value: unknown): PruneCandidate[] =>
  (Array.isArray(value) ? value : []).filter(
    (row: unknown): row is PruneCandidate =>
      typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "number",
  );

const countOf = (result: unknown): number => {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === "number" ? count : 0;
};

/** Deletes the prunable notifications; returns how many rows went. */
export async function pruneNotifications(
  strapi: NotificationJanitorStrapi,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = notificationPruneCutoff(now);
  const where = prunableNotificationWhere(cutoff);
  const notifications = strapi.db.query(NOTIFICATION_UID);
  let deleted = 0;
  let afterId = 0;
  for (let batch = 0; batch < NOTIFICATION_PRUNE_MAX_BATCHES; batch++) {
    const rows = rowsOf(
      await notifications.findMany({
        where: { $and: [where, { id: { $gt: afterId } }] },
        select: ["id", "readAt", "createdAt", "sourceType", "sourceDocumentId"],
        orderBy: { id: "asc" },
        limit: NOTIFICATION_PRUNE_BATCH,
      }),
    );
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    const ids = rows.filter((row) => isPrunableNotification(row, cutoff)).map((row) => row.id);
    if (ids.length > 0) {
      deleted += countOf(await notifications.deleteMany({ where: { id: { $in: ids } } }));
    }
    if (rows.length < NOTIFICATION_PRUNE_BATCH) break;
  }
  if (deleted > 0) {
    strapi.log.info(
      `[notification-janitor] pruned ${deleted} read notification(s) read more than ` +
        `${NOTIFICATION_RETENTION_DAYS} days ago (fan-out anchors and unread rows are kept)`,
    );
  }
  return deleted;
}
