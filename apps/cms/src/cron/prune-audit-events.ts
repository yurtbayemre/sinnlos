import { AUDIT_EVENT_UID, DEFAULT_AUDIT_RETENTION_DAYS, runAsAuditJanitor } from "../utils/audit";

/**
 * Nightly retention of the content activity trail (decision 06 §H, LF07;
 * batch 15 plan item 7): `audit-janitor`, 03:50 APP_TIME_ZONE
 * (cron/registry.ts), deletes the audit rows created more than
 * AUDIT_RETENTION_DAYS days ago (default 365; question 10).
 *
 * `AUDIT_RETENTION_DAYS` must be a whole number of days, at least 1. Any
 * other value is an error line and the run deletes nothing: retention
 * fails closed (keeping rows), never towards deleting more.
 *
 * Deletion: id pages of AUDIT_PRUNE_BATCH, one `deleteMany` per page, under
 * the janitor marker (utils/audit.ts runAsAuditJanitor; the append-only
 * lifecycle refuses every other deleter). At most AUDIT_PRUNE_MAX_BATCHES
 * pages per run; a backlog continues the next night. Like the other
 * janitors it removes only old rows, so when the nightly backup runs does
 * not matter (cron/registry.ts). Errors propagate to the cron wrapper.
 */

/** Rows per read and per `deleteMany`. */
export const AUDIT_PRUNE_BATCH = 500;
/** Pages per run: at most 100 000 rows a night. */
export const AUDIT_PRUNE_MAX_BATCHES = 200;

export const AUDIT_JANITOR_LOG = "[audit-janitor]";

const DAY_MS = 86_400_000;

/** The slice of the Strapi instance the janitor uses. */
export interface AuditJanitorStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      deleteMany(params: Record<string, unknown>): Promise<{ count?: number } | unknown>;
    };
  };
  log: { info(message: string): void; error(message: string): void };
}

/** AUDIT_RETENTION_DAYS → days, the default when unset; null when invalid. */
export function auditRetentionDays(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return DEFAULT_AUDIT_RETENTION_DAYS;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return Number.isSafeInteger(days) && days >= 1 ? days : null;
}

const idsOf = (value: unknown): number[] =>
  (Array.isArray(value) ? value : [])
    .map((row: unknown) =>
      typeof row === "object" && row !== null ? (row as { id?: unknown }).id : null,
    )
    .filter((id): id is number => typeof id === "number");

const countOf = (result: unknown): number => {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === "number" ? count : 0;
};

/** Deletes the audit rows older than the retention; returns how many went. */
export async function pruneAuditEvents(
  strapi: AuditJanitorStrapi,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const days = auditRetentionDays(env.AUDIT_RETENTION_DAYS);
  if (days === null) {
    strapi.log.error(
      `${AUDIT_JANITOR_LOG} AUDIT_RETENTION_DAYS=${JSON.stringify(env.AUDIT_RETENTION_DAYS)} is not ` +
        "a whole number of days (at least 1); nothing was deleted",
    );
    return 0;
  }
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const query = strapi.db.query(AUDIT_EVENT_UID);
  let pruned = 0;
  for (let batch = 0; batch < AUDIT_PRUNE_MAX_BATCHES; batch += 1) {
    const ids = idsOf(
      await query.findMany({
        where: { createdAt: { $lt: cutoff } },
        select: ["id"],
        orderBy: { id: "asc" },
        limit: AUDIT_PRUNE_BATCH,
      }),
    );
    if (ids.length === 0) break;
    pruned += countOf(
      await runAsAuditJanitor(() =>
        query.deleteMany({ where: { id: { $in: ids }, createdAt: { $lt: cutoff } } }),
      ),
    );
    if (ids.length < AUDIT_PRUNE_BATCH) break;
  }
  if (pruned > 0) {
    strapi.log.info(
      `${AUDIT_JANITOR_LOG} pruned ${pruned} audit event(s) created before ${cutoff} ` +
        `(AUDIT_RETENTION_DAYS=${days})`,
    );
  }
  return pruned;
}
