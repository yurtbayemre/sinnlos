/**
 * Nightly retention for the anonymous search telemetry (issue #19):
 * rows older than 90 days carry no analytical value (the summary window
 * caps at 365 but the decision question — "does search work?" — is
 * answered on much fresher data) and unbounded telemetry growth on a
 * small host is exactly the kind of silent creep the repo avoids.
 */

const RETENTION_DAYS = 90;

export async function pruneSearchLogs(strapi: any): Promise<void> {
  try {
    // A Date binding, never an ISO string (FX25, datetime contract C8):
    // knex binds a Date as epoch ms on SQLite, where created_at holds epoch
    // ms (an ISO string compared as TEXT deleted every row there), and as an
    // absolute instant on Postgres.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
    const deleted = await strapi.db
      .connection("search_logs")
      .where("created_at", "<", cutoff)
      .del();
    if (deleted > 0) strapi.log.info(`[search-log-janitor] pruned ${deleted} row(s)`);
  } catch (err) {
    strapi.log.warn(`[search-log-janitor] prune failed: ${(err as Error).message}`);
  }
}
