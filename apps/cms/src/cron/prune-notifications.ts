/**
 * Nightly retention for notifications (LF07, owner answer 2026-09-29 (b);
 * v0.28 M11, owner decisions 2026-10-23):
 *   - a READ notification is deleted 90 days after it was read (and it is
 *     at least that old: readAt never precedes createdAt, both are checked);
 *   - an UNREAD notification is deleted 180 days after it was created
 *     (v0.28; before, it never expired);
 *   - a fan-out ANCHOR row is kept, read or not, while its source document
 *     exists in any state: a notification that carries `sourceType` or
 *     `sourceDocumentId` is the dedup ledger of the announcement/event
 *     fan-out and of the training reminders (utils/notification-source.ts,
 *     §5.26). Deleting it would make the next re-publish notify that
 *     recipient again (or the next morning's reminder run send the cycle
 *     again), and would let the digest's republish check (send-digests.ts)
 *     mail an old announcement as news. A blocked recipient keeps their
 *     anchors: blocking is reversible, and an unblocked person must not get
 *     old news again.
 *   - an anchor whose source is GONE in every state (no draft, no published
 *     row: utils/existing-documents.ts) is ledger of nothing; it follows the
 *     two age rules above (`pruneOrphanedAnchors`). The source is the
 *     `sourceDocumentId` of an announcement or event anchor, and the course
 *     documentId of a training anchor `<course>@<due day>:soon|expired`. A
 *     half-set or malformed anchor names no checkable source and is kept.
 *
 * Runs at 03:40 APP_TIME_ZONE, after the 03:00 host backup (registry.ts),
 * so every row it removes is still in that night's dump.
 *
 * Deletion of the un-anchored rows: id pages of NOTIFICATION_PRUNE_BATCH
 * through an id cursor, the rows re-checked with the pure rule
 * (isPrunableNotification) before their ids are deleted, one `deleteMany`
 * per page. The link rows of `recipient` and `actor` go with them: Strapi's
 * link tables reference the row with ON DELETE CASCADE (@strapi/database
 * 5.55.1 metadata/relations.js; SQLite runs with foreign_keys on), pinned
 * for both engines in integration/retention.integration.test.ts. No live
 * ping: a pruned row is old, and the bell refetches on its own schedule. At
 * most NOTIFICATION_PRUNE_MAX_BATCHES pages per run (the first night after
 * the deploy may find a backlog); the rest follows the next night.
 *
 * The anchors: one DISTINCT read of the anchor pairs (a few per source,
 * however many recipients), their sources looked up per type, then one
 * `deleteMany` per type and chunk of gone sources, with the age rules in
 * its `where`. Old anchors of live sources are never paged through, so
 * they cannot crowd out the rows that may go.
 *
 * Errors propagate to the cron wrapper (guardedTask logs them); rows
 * deleted before the error stay deleted, which is harmless: every deleted
 * row passed the rule.
 */
import { COURSE_UID } from "../utils/authoring-uids";
import { existingDocumentIds, type ExistingDocumentsHost } from "../utils/existing-documents";
import {
  UNANCHORED_NOTIFICATION_WHERE,
  isAnchoredNotification,
} from "../utils/notification-source";
import { instantMsOrNull } from "../utils/time";

/** Days a READ notification is kept after it was read (owner decision). */
export const NOTIFICATION_RETENTION_DAYS = 90;
/** Days an UNREAD notification is kept after it was created (v0.28). */
export const NOTIFICATION_UNREAD_RETENTION_DAYS = 180;
/** Rows per read and per `deleteMany`. */
export const NOTIFICATION_PRUNE_BATCH = 500;
/** Pages per run: at most 100 000 rows a night. */
export const NOTIFICATION_PRUNE_MAX_BATCHES = 200;

const NOTIFICATION_UID = "api::notification.notification";
const ANNOUNCEMENT_UID = "api::announcement.announcement";
const EVENT_UID = "api::event.event";
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

/** The anchor pass also reads the distinct anchor pairs through knex. */
export interface AnchorJanitorStrapi extends NotificationJanitorStrapi {
  db: NotificationJanitorStrapi["db"] & {
    getConnection(table: string): {
      distinct(...columns: string[]): {
        where(callback: (builder: AnchorWhereBuilder) => void): Promise<unknown[]>;
      };
    };
    metadata: {
      get(uid: string): { tableName: string; attributes: Record<string, { columnName?: string }> };
    };
  };
}

interface AnchorWhereBuilder {
  whereNotNull(column: string): AnchorWhereBuilder;
  orWhereNotNull(column: string): AnchorWhereBuilder;
}

/** The two cutoffs: rows read, or (unread) created, before them are old enough. */
export interface NotificationPruneCutoffs {
  read: Date;
  unread: Date;
}

/** Rows read (or created) before this instant are old enough for the READ rule. */
export function notificationPruneCutoff(
  now: Date,
  days: number = NOTIFICATION_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** Both cutoffs at `now`. */
export function notificationPruneCutoffs(now: Date): NotificationPruneCutoffs {
  return {
    read: notificationPruneCutoff(now, NOTIFICATION_RETENTION_DAYS),
    unread: notificationPruneCutoff(now, NOTIFICATION_UNREAD_RETENTION_DAYS),
  };
}

const asInstantInput = (value: unknown): string | Date | null =>
  typeof value === "string" || value instanceof Date ? value : null;

const msOf = (value: unknown): number | null => {
  const input = asInstantInput(value);
  return input == null ? null : instantMsOrNull(input);
};

/**
 * The age rule (pure): read before the read cutoff (and created before it),
 * or unread and created before the unread cutoff. Anything unparseable is
 * kept: deletion is the irreversible arm, so this fails closed.
 */
export function isAgedOutNotification(
  row: PruneCandidate,
  cutoffs: NotificationPruneCutoffs,
): boolean {
  const createdMs = msOf(row.createdAt);
  if (createdMs == null) return false;
  if (row.readAt == null) return createdMs < cutoffs.unread.getTime();
  const readMs = msOf(row.readAt);
  if (readMs == null) return false;
  return readMs < cutoffs.read.getTime() && createdMs < cutoffs.read.getTime();
}

/** The un-anchored rule (pure): no fan-out anchor, and aged out. */
export function isPrunableNotification(
  row: PruneCandidate,
  cutoffs: NotificationPruneCutoffs,
): boolean {
  return !isAnchoredNotification(row) && isAgedOutNotification(row, cutoffs);
}

/** The age rule as a query-engine where clause (the database's side of it). */
export function agedOutNotificationWhere(
  cutoffs: NotificationPruneCutoffs,
): Record<string, unknown> {
  const read = cutoffs.read.toISOString();
  return {
    $or: [
      {
        $and: [
          { readAt: { $notNull: true } },
          { readAt: { $lt: read } },
          { createdAt: { $lt: read } },
        ],
      },
      { $and: [{ readAt: { $null: true } }, { createdAt: { $lt: cutoffs.unread.toISOString() } }] },
    ],
  };
}

/** The un-anchored rule as a where clause. */
export function prunableNotificationWhere(
  cutoffs: NotificationPruneCutoffs,
): Record<string, unknown> {
  return { $and: [agedOutNotificationWhere(cutoffs), UNANCHORED_NOTIFICATION_WHERE] };
}

/** A training reminder anchor: `<course documentId>@<YYYY-MM-DD>:soon|expired`. */
const COURSE_ANCHOR = /^([A-Za-z0-9]+)@\d{4}-\d{2}-\d{2}:(?:soon|expired)$/;

/**
 * The document an anchor depends on (pure), or null when the anchor names
 * none that can be checked (half-set, unknown type, malformed): kept.
 */
export function anchorSource(row: {
  sourceType?: unknown;
  sourceDocumentId?: unknown;
}): { uid: string; documentId: string } | null {
  const documentId = typeof row.sourceDocumentId === "string" ? row.sourceDocumentId : "";
  if (documentId === "" || documentId.trim() !== documentId) return null;
  switch (row.sourceType) {
    case "announcement":
      return { uid: ANNOUNCEMENT_UID, documentId };
    case "event":
      return { uid: EVENT_UID, documentId };
    case "course": {
      const course = COURSE_ANCHOR.exec(documentId);
      return course ? { uid: COURSE_UID, documentId: course[1] } : null;
    }
    default:
      return null;
  }
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

/** Deletes the prunable un-anchored notifications; returns how many rows went. */
export async function pruneNotifications(
  strapi: NotificationJanitorStrapi,
  now: Date = new Date(),
): Promise<number> {
  const cutoffs = notificationPruneCutoffs(now);
  const where = prunableNotificationWhere(cutoffs);
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
    const ids = rows.filter((row) => isPrunableNotification(row, cutoffs)).map((row) => row.id);
    if (ids.length > 0) {
      deleted += countOf(await notifications.deleteMany({ where: { id: { $in: ids } } }));
    }
    if (rows.length < NOTIFICATION_PRUNE_BATCH) break;
  }
  if (deleted > 0) {
    strapi.log.info(
      `[notification-janitor] pruned ${deleted} notification(s) read more than ` +
        `${NOTIFICATION_RETENTION_DAYS} days ago or unread for more than ` +
        `${NOTIFICATION_UNREAD_RETENTION_DAYS} days (fan-out anchors are kept)`,
    );
  }
  return deleted;
}

/** Deletes the aged-out anchors whose source is gone in every state; returns how many went. */
export async function pruneOrphanedAnchors(
  strapi: AnchorJanitorStrapi,
  now: Date = new Date(),
): Promise<number> {
  const meta = strapi.db.metadata.get(NOTIFICATION_UID);
  const typeColumn = meta.attributes.sourceType?.columnName ?? "source_type";
  const idColumn = meta.attributes.sourceDocumentId?.columnName ?? "source_document_id";
  const pairs = await strapi.db
    .getConnection(meta.tableName)
    .distinct(`${typeColumn} as sourceType`, `${idColumn} as sourceDocumentId`)
    .where((builder) => builder.whereNotNull(typeColumn).orWhereNotNull(idColumn));

  // source uid → source documentId → the anchor values that depend on it
  const bySource = new Map<string, Map<string, { sourceType: string; anchors: string[] }>>();
  for (const pair of pairs as Array<{ sourceType?: unknown; sourceDocumentId?: unknown }>) {
    const source = anchorSource(pair);
    if (!source) continue;
    const ofUid = bySource.get(source.uid) ?? new Map();
    const entry = ofUid.get(source.documentId) ?? {
      sourceType: pair.sourceType as string,
      anchors: [],
    };
    entry.anchors.push(pair.sourceDocumentId as string);
    ofUid.set(source.documentId, entry);
    bySource.set(source.uid, ofUid);
  }

  const aged = agedOutNotificationWhere(notificationPruneCutoffs(now));
  const notifications = strapi.db.query(NOTIFICATION_UID);
  let deleted = 0;
  for (const [uid, sources] of bySource) {
    const existing = await existingDocumentIds(
      strapi as unknown as ExistingDocumentsHost,
      uid,
      sources.keys(),
    );
    const gone = new Map<string, string[]>(); // sourceType → anchor values
    for (const [documentId, { sourceType, anchors }] of sources) {
      if (existing.has(documentId)) continue;
      gone.set(sourceType, [...(gone.get(sourceType) ?? []), ...anchors]);
    }
    for (const [sourceType, anchors] of gone) {
      for (let start = 0; start < anchors.length; start += NOTIFICATION_PRUNE_BATCH) {
        deleted += countOf(
          await notifications.deleteMany({
            where: {
              $and: [
                { sourceType },
                {
                  sourceDocumentId: { $in: anchors.slice(start, start + NOTIFICATION_PRUNE_BATCH) },
                },
                aged,
              ],
            },
          }),
        );
      }
    }
  }
  if (deleted > 0) {
    strapi.log.info(
      `[notification-janitor] pruned ${deleted} old fan-out anchor(s) whose source no longer exists`,
    );
  }
  return deleted;
}
