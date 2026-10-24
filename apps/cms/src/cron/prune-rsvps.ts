import { EVENT_UID } from "../utils/authoring-uids";
import { lockDocument, type DocumentLockHost } from "../utils/document-lock";
import { EXISTING_DOCUMENTS_CHUNK } from "../utils/existing-documents";
import { instantMsOrNull } from "../utils/time";
import { reportRunFailure } from "./run-context";

/**
 * Nightly retention of RSVPs (v0.28, M11; plan rev3 R6): the answers to an
 * event are deleted RSVP_RETENTION_DAYS after the event ended, all of them
 * at once (they are anchored to the event's documentId).
 *
 * THE RULE (pure, `rsvpsExpired`), over EVERY surviving row of the event
 * document: a draft and its published row can carry different dates (a
 * rescheduled draft, an old draft of an upcoming event), so each row must
 * have a parseable effective end, `end` or else `start`, more than
 * RSVP_RETENTION_DAYS ago. An `end` that is set but unparseable keeps the
 * answers (no fallback to `start`), and so does any row without a usable
 * date: deletion fails closed. An event gone in every state (no row at
 * all) has nothing left to answer for: its RSVPs go. Strapi never reuses a
 * documentId, so that state is permanent.
 *
 * LOCKING. An event that still exists is re-checked under its document
 * lock (the lock every Document Service write of an event takes) in the
 * delete's own transaction: a reschedule committed before the lock is seen
 * by the re-read, one that comes after waits for the delete. The delete
 * writes RSVP rows only (not a guarded type), so no revision advance.
 *
 * The run reads the DISTINCT events the RSVPs answer (one row per event,
 * however many people answered), judges every one with the rule, and then
 * deletes the RSVPs of at most RSVP_PRUNE_MAX_EVENTS due events (the rest
 * follows the next night). Events the rule keeps are never counted against
 * that cap, so however many there are, they cannot hide a due one. The user
 * link rows go with the RSVPs (ON DELETE CASCADE,
 * integration/retention-v028.integration.test.ts). Runs at 03:54
 * APP_TIME_ZONE (cron/registry.ts); one failing event is logged and
 * skipped, the next night retries it.
 */

/** Days after an event's end before its RSVPs go. */
export const RSVP_RETENTION_DAYS = 180;
/** Due events whose RSVPs one run deletes. */
export const RSVP_PRUNE_MAX_EVENTS = 500;

export const RSVP_JANITOR_LOG = "[rsvp-janitor]";

const RSVP_UID = "api::event-rsvp.event-rsvp";
const DAY_MS = 86_400_000;

/** The slice of the Strapi instance the janitor uses. */
export interface RsvpJanitorStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      deleteMany(params: Record<string, unknown>): Promise<{ count?: number } | unknown>;
    };
    transaction<T>(callback: () => Promise<T>): Promise<T>;
    getConnection(table: string): { distinct(...columns: string[]): PromiseLike<unknown[]> };
    metadata: {
      get(uid: string): { tableName: string; attributes: Record<string, { columnName?: string }> };
    };
  };
  log: { info(message: string): void; error(message: string): void };
}

/** An event row as the rule reads it. */
export interface EventDateRow {
  start?: unknown;
  end?: unknown;
}

const msOf = (value: unknown): number | null =>
  typeof value === "string" || value instanceof Date ? instantMsOrNull(value) : null;

/** Whether the RSVPs of the event with these rows go at `now` (see THE RULE; [] = gone). */
export function rsvpsExpired(
  rows: readonly EventDateRow[],
  now: Date,
  days: number = RSVP_RETENTION_DAYS,
): boolean {
  if (rows.length === 0) return true;
  const cutoff = now.getTime() - days * DAY_MS;
  return rows.every((row) => {
    const end = row.end == null || row.end === "" ? row.start : row.end;
    const ms = msOf(end);
    return ms != null && ms < cutoff;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const listOf = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).filter(isRecord);

const countOf = (result: unknown): number => {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === "number" ? count : 0;
};

/** The event rows of `documentIds`, grouped by documentId (absent: gone). */
async function eventRows(
  strapi: RsvpJanitorStrapi,
  documentIds: readonly string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (let start = 0; start < documentIds.length; start += EXISTING_DOCUMENTS_CHUNK) {
    const rows = listOf(
      await strapi.db.query(EVENT_UID).findMany({
        where: { documentId: { $in: documentIds.slice(start, start + EXISTING_DOCUMENTS_CHUNK) } },
        select: ["id", "documentId", "start", "end"],
      }),
    );
    for (const row of rows) {
      const documentId = row.documentId as string;
      grouped.set(documentId, [...(grouped.get(documentId) ?? []), row]);
    }
  }
  return grouped;
}

/** Deletes the RSVPs of one event when the rule holds (under its lock while it exists). */
async function pruneEvent(
  strapi: RsvpJanitorStrapi,
  documentId: string,
  exists: boolean,
  now: Date,
): Promise<number> {
  const rsvps = strapi.db.query(RSVP_UID);
  if (!exists) return countOf(await rsvps.deleteMany({ where: { targetDocumentId: documentId } }));
  return strapi.db.transaction(async () => {
    await lockDocument(strapi as unknown as DocumentLockHost, EVENT_UID, documentId);
    // No rows now: the event was deleted while we waited, its RSVPs go too.
    const rows = (await eventRows(strapi, [documentId])).get(documentId) ?? [];
    if (!rsvpsExpired(rows, now)) return 0;
    return countOf(await rsvps.deleteMany({ where: { targetDocumentId: documentId } }));
  });
}

/** The nightly run; returns how many RSVPs went. */
export async function pruneRsvps(
  strapi: RsvpJanitorStrapi,
  now: Date = new Date(),
): Promise<number> {
  const meta = strapi.db.metadata.get(RSVP_UID);
  const column = meta.attributes.targetDocumentId?.columnName ?? "target_document_id";
  const answered = (
    (await strapi.db
      .getConnection(meta.tableName)
      .distinct(`${column} as targetDocumentId`)) as Array<{ targetDocumentId?: unknown }>
  )
    .map((row) => row.targetDocumentId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  const rows = await eventRows(strapi, answered);
  const due = answered.filter((documentId) => rsvpsExpired(rows.get(documentId) ?? [], now));

  let deleted = 0;
  for (const documentId of due.slice(0, RSVP_PRUNE_MAX_EVENTS)) {
    try {
      deleted += await pruneEvent(strapi, documentId, rows.has(documentId), now);
    } catch (err) {
      reportRunFailure(
        err,
        `event ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      strapi.log.error(
        `${RSVP_JANITOR_LOG} event ${documentId} failed, retried next night: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  if (deleted > 0) {
    strapi.log.info(
      `${RSVP_JANITOR_LOG} pruned ${deleted} RSVP(s) of events that ended more than ` +
        `${RSVP_RETENTION_DAYS} days ago or no longer exist`,
    );
  }
  return deleted;
}
