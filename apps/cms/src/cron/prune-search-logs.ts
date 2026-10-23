/**
 * Nightly retention for the search telemetry (issue #19; v0.28 M11): rows
 * older than SEARCH_LOG_RETENTION_DAYS (default 90) go. Old rows carry no
 * analytical value (the summary window caps at 365, but the question "does
 * search work?" is answered on much fresher data), and unbounded telemetry
 * growth on a small host is the kind of silent creep the repo avoids. The
 * rows name no user, but a search term itself can (the data inventory,
 * docs/data-protection.md, says so).
 *
 * `SEARCH_LOG_RETENTION_DAYS` is a whole number of days, 1 to 3650. The cms
 * refuses to boot with any other value (`assertSearchLogRetention`,
 * index.ts register()); should the run still meet one, it deletes nothing
 * and says so: retention fails closed.
 */

/** Days a search log row is kept (`SEARCH_LOG_RETENTION_DAYS` unset or blank). */
export const DEFAULT_SEARCH_LOG_RETENTION_DAYS = 90;
/** The longest retention the env may set (ten years). */
export const MAX_SEARCH_LOG_RETENTION_DAYS = 3650;

/** SEARCH_LOG_RETENTION_DAYS → days, the default when unset; null when invalid. */
export function searchLogRetentionDays(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return DEFAULT_SEARCH_LOG_RETENTION_DAYS;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days >= 1 && days <= MAX_SEARCH_LOG_RETENTION_DAYS ? days : null;
}

/** Refuses the boot on an invalid SEARCH_LOG_RETENTION_DAYS (register()). */
export function assertSearchLogRetention(env: Record<string, string | undefined>): void {
  if (searchLogRetentionDays(env.SEARCH_LOG_RETENTION_DAYS) !== null) return;
  throw new Error(
    `[search-log-janitor] SEARCH_LOG_RETENTION_DAYS=${JSON.stringify(env.SEARCH_LOG_RETENTION_DAYS)} ` +
      `is not a whole number of days from 1 to ${MAX_SEARCH_LOG_RETENTION_DAYS}`,
  );
}

export async function pruneSearchLogs(
  strapi: any,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<void> {
  const days = searchLogRetentionDays(env.SEARCH_LOG_RETENTION_DAYS);
  if (days === null) {
    strapi.log.error(
      `[search-log-janitor] SEARCH_LOG_RETENTION_DAYS=${JSON.stringify(env.SEARCH_LOG_RETENTION_DAYS)} ` +
        "is invalid; nothing was deleted",
    );
    return;
  }
  try {
    // A Date binding, never an ISO string (FX25, datetime contract C8):
    // knex binds a Date as epoch ms on SQLite, where created_at holds epoch
    // ms (an ISO string compared as TEXT deleted every row there), and as an
    // absolute instant on Postgres.
    const cutoff = new Date(now.getTime() - days * 86400000);
    const deleted = await strapi.db
      .connection("search_logs")
      .where("created_at", "<", cutoff)
      .del();
    if (deleted > 0) {
      strapi.log.info(`[search-log-janitor] pruned ${deleted} row(s) older than ${days} days`);
    }
  } catch (err) {
    strapi.log.warn(`[search-log-janitor] prune failed: ${(err as Error).message}`);
  }
}
