import { EVENT_UID } from "../utils/authoring-uids";
import { lockDocument, type DocumentLockHost } from "../utils/document-lock";
import { instantMsOrNull } from "../utils/time";

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
 * Paging: RSVP id pages of RSVP_PRUNE_BATCH, each event decided once per
 * run, at most RSVP_PRUNE_MAX_EVENTS events a run (the rest follows the
 * next night). The user link rows go with the RSVPs (ON DELETE CASCADE,
 * integration/retention-v028.integration.test.ts). Runs at 03:54
 * APP_TIME_ZONE (cron/registry.ts); one failing event is logged and
 * skipped, the next night retries it.
 */

/** Days after an event's end before its RSVPs go. */
export const RSVP_RETENTION_DAYS = 180;
/** RSVP rows per read. */
export const RSVP_PRUNE_BATCH = 500;
/** Events decided per run. */
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
  for (const row of listOf(
    await strapi.db.query(EVENT_UID).findMany({
      where: { documentId: { $in: [...documentIds] } },
      select: ["id", "documentId", "start", "end"],
    }),
  )) {
    const documentId = row.documentId as string;
    grouped.set(documentId, [...(grouped.get(documentId) ?? []), row]);
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
  const decided = new Set<string>();
  let deleted = 0;
  let afterId = 0;
  while (decided.size < RSVP_PRUNE_MAX_EVENTS) {
    const page = listOf(
      await strapi.db.query(RSVP_UID).findMany({
        where: { id: { $gt: afterId } },
        select: ["id", "targetDocumentId"],
        orderBy: { id: "asc" },
        limit: RSVP_PRUNE_BATCH,
      }),
    );
    if (page.length === 0) break;
    afterId = page[page.length - 1].id as number;
    const fresh = [
      ...new Set(
        page
          .map((row) => row.targetDocumentId)
          .filter((id): id is string => typeof id === "string" && id !== "" && !decided.has(id)),
      ),
    ].slice(0, RSVP_PRUNE_MAX_EVENTS - decided.size);
    const rows = await eventRows(strapi, fresh);
    for (const documentId of fresh) {
      decided.add(documentId);
      const own = rows.get(documentId) ?? [];
      if (!rsvpsExpired(own, now)) continue;
      try {
        deleted += await pruneEvent(strapi, documentId, own.length > 0, now);
      } catch (err) {
        strapi.log.error(
          `${RSVP_JANITOR_LOG} event ${documentId} failed, retried next night: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    if (page.length < RSVP_PRUNE_BATCH) break;
  }
  if (deleted > 0) {
    strapi.log.info(
      `${RSVP_JANITOR_LOG} pruned ${deleted} RSVP(s) of events that ended more than ` +
        `${RSVP_RETENTION_DAYS} days ago or no longer exist`,
    );
  }
  return deleted;
}
