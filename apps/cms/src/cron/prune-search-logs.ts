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
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
    const deleted = await strapi.db
      .connection("search_logs")
      .where("created_at", "<", cutoff)
      .del();
    if (deleted > 0) strapi.log.info(`[search-log-janitor] pruned ${deleted} row(s)`);
  } catch (err) {
    strapi.log.warn(`[search-log-janitor] prune failed: ${(err as Error).message}`);
  }
}
