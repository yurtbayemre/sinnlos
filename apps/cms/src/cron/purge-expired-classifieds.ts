/**
 * Nightly purge of long-expired marketplace ads (LF07; owner default of
 * 2026-09-29 (b)): an ad whose `expiresAt` lies more than 90 days before
 * today (APP_TIME_ZONE) is deleted, with its images.
 *
 * `expiresAt` is a calendar date, the last day the ad is listed
 * (utils/classified-expiry.ts); the web lists `expiresAt >= today`, so an
 * ad is expired from the day after it. It stays in the database for 90
 * more days (the author can still renew it through the API meanwhile) and
 * is purged when `expiresAt < today - 90 days`, compared in calendar-date
 * space around "today" in APP_TIME_ZONE (todayIn), so the boundary cannot
 * drift by a day with the process zone around midnight.
 *
 * Deletion goes through the Document Service, one ad at a time, like a
 * delete in the admin panel or through the API: the classified lifecycles
 * then remove the ad's marketplace images after the commit
 * (api/classified/content-types/classified/lifecycles.ts, issue #13), and
 * the nightly uploads janitor catches any image that refused to go. A bulk
 * `deleteMany` would skip those lifecycles.
 *
 * RENEWED MEANWHILE. The candidates come from a page read, and the author
 * can renew an expired ad (the web's Renew button sets a new `expiresAt`)
 * between that read and the ad's delete. So each ad is deleted in its own
 * transaction that first locks its row (`FOR UPDATE`, Postgres only; SQLite
 * runs one transaction at a time), then re-reads it and deletes it only if
 * the rule still holds. A renewal committed before the lock is seen by the
 * re-read (a new statement under Read Committed) and the ad is skipped; a
 * renewal that reaches the row after the lock waits for the purge's commit
 * and then updates nothing (the ad is gone). The Document Service delete
 * joins this transaction (@strapi/database 5.55.1 reuses an ambient one),
 * so the image removal still runs after its commit, and a failed delete
 * rolls back with it.
 *
 * Runs at 03:45 APP_TIME_ZONE, after the 03:00 host backup (registry.ts),
 * so every ad and image it removes is still in that night's backup. At
 * most CLASSIFIED_PURGE_MAX_PER_RUN ads per run; the rest follows the next
 * night. One failing ad is logged and skipped (its delete rolled back on
 * its own), the others still go; the next night retries it.
 */
import { comparePlainDates, todayIn, tryParsePlainDate, type PlainDate } from "../utils/time";

/** Days an expired ad is kept after its last listed day (owner default). */
export const CLASSIFIED_PURGE_DAYS = 90;
/** Rows per read. */
export const CLASSIFIED_PURGE_BATCH = 100;
/** Ads per run. */
export const CLASSIFIED_PURGE_MAX_PER_RUN = 1000;

const CLASSIFIED_UID = "api::classified.classified";

/** An ad as the janitor reads it. */
export interface PurgeCandidate {
  id: number;
  documentId?: unknown;
  expiresAt?: unknown;
}

/** The query builder slice that locks an ad row (Postgres). */
interface LockQuery {
  select(columns: string[]): LockQuery;
  where(where: Record<string, unknown>): LockQuery;
  forUpdate(): LockQuery;
  execute(): Promise<unknown>;
}

/** The slice of the Strapi instance the janitor uses. */
export interface ClassifiedJanitorStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      findOne(params: Record<string, unknown>): Promise<unknown>;
    };
    /**
     * One transaction around `callback`: queries and Document Service calls
     * inside join it (@strapi/database keeps it in AsyncLocalStorage).
     */
    transaction<T>(callback: () => Promise<T>): Promise<T>;
    /** Joins the ambient transaction on execute(). */
    queryBuilder(uid: string): LockQuery;
    /** 'postgres' or 'sqlite'. */
    dialect: { client: string };
  };
  documents(uid: string): { delete(params: { documentId: string }): Promise<unknown> };
  log: { info(message: string): void; warn(message: string): void };
}

/** Ads with `expiresAt` before this date go: today minus CLASSIFIED_PURGE_DAYS. */
export function classifiedPurgeCutoff(
  today: PlainDate,
  days: number = CLASSIFIED_PURGE_DAYS,
): PlainDate {
  return today.subtract({ days });
}

/**
 * The rule (pure): a 'YYYY-MM-DD' expiry strictly before the cutoff and a
 * documentId to delete by. Anything else (a missing or unparseable date, a
 * Date object whose calendar day would depend on a zone) is kept: this
 * fails closed.
 */
export function isPurgeableClassified(row: PurgeCandidate, cutoff: PlainDate): boolean {
  if (typeof row.documentId !== "string" || row.documentId === "") return false;
  const expiresAt = typeof row.expiresAt === "string" ? tryParsePlainDate(row.expiresAt) : null;
  return expiresAt != null && comparePlainDates(expiresAt, cutoff) < 0;
}

const isCandidate = (row: unknown): row is PurgeCandidate =>
  typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "number";

const rowsOf = (value: unknown): PurgeCandidate[] =>
  (Array.isArray(value) ? value : []).filter(isCandidate);

/**
 * Deletes one ad of a page read, unless it changed since: in its own
 * transaction, locked (Postgres), re-read and re-checked (see RENEWED
 * MEANWHILE). Returns whether it was deleted; a failure throws and rolls
 * back.
 */
async function purgeOne(
  strapi: ClassifiedJanitorStrapi,
  row: PurgeCandidate,
  cutoff: PlainDate,
): Promise<boolean> {
  return strapi.db.transaction(async () => {
    if (strapi.db.dialect.client === "postgres") {
      await strapi.db
        .queryBuilder(CLASSIFIED_UID)
        .select(["id"])
        .where({ id: row.id })
        .forUpdate()
        .execute();
    }
    const fresh = await strapi.db.query(CLASSIFIED_UID).findOne({
      where: { id: row.id },
      select: ["id", "documentId", "expiresAt"],
    });
    if (!isCandidate(fresh) || !isPurgeableClassified(fresh, cutoff)) return false;
    await strapi.documents(CLASSIFIED_UID).delete({ documentId: fresh.documentId as string });
    return true;
  });
}

/** Deletes the long-expired ads; returns how many went. */
export async function purgeExpiredClassifieds(
  strapi: ClassifiedJanitorStrapi,
  today: PlainDate = todayIn(),
): Promise<number> {
  const cutoff = classifiedPurgeCutoff(today);
  const ads = strapi.db.query(CLASSIFIED_UID);
  let purged = 0;
  let skipped = 0;
  let failed = 0;
  let afterId = 0;
  let seen = 0;
  while (seen < CLASSIFIED_PURGE_MAX_PER_RUN) {
    const rows = rowsOf(
      await ads.findMany({
        where: { expiresAt: { $lt: cutoff.toString() }, id: { $gt: afterId } },
        select: ["id", "documentId", "expiresAt"],
        orderBy: { id: "asc" },
        limit: Math.min(CLASSIFIED_PURGE_BATCH, CLASSIFIED_PURGE_MAX_PER_RUN - seen),
      }),
    );
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    seen += rows.length;
    for (const row of rows) {
      if (!isPurgeableClassified(row, cutoff)) continue;
      try {
        if (await purgeOne(strapi, row, cutoff)) purged++;
        else skipped++;
      } catch (err) {
        failed++;
        strapi.log.warn(
          `[classified-janitor] ad ${row.id} could not be deleted: ${(err as Error).message}`,
        );
      }
    }
    if (rows.length < CLASSIFIED_PURGE_BATCH) break;
  }
  if (purged > 0 || skipped > 0 || failed > 0) {
    strapi.log.info(
      `[classified-janitor] purged ${purged} ad(s) expired before ${cutoff.toString()} ` +
        `(${CLASSIFIED_PURGE_DAYS} days after their last day)` +
        (skipped > 0 ? `, ${skipped} renewed or deleted meanwhile and skipped` : "") +
        (failed > 0 ? `, ${failed} failed and stay for the next night` : ""),
    );
  }
  return purged;
}
