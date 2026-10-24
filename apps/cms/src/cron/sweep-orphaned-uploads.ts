/**
 * Nightly janitor for orphaned uploads (issue #13, option 3; decision 06
 * §E3, §E5, batch 16 lane 16A).
 *
 * The two-step web flows (upload → create or update) can strand files
 * despite the best-effort cleanup (web container dies between the steps,
 * the cleanup POST itself fails, a document form is abandoned, …). This
 * sweep is the net under the net: daily at 03:30 APP_TIME_ZONE
 * (cron/registry.ts). A swept file is older than 24 h, so the previous
 * nightly backup holds it whenever that backup runs.
 *
 * SCOPE. Every file the hardened POST /api/upload stamped with
 * `provider_metadata.uploadedBy`: marketplace images of every role and,
 * since batch 16, the document uploads of moderators and department heads
 * (PDF, Office, images). Admin uploads (avatars, documents and media
 * uploaded in the admin panel) carry no stamp and are NEVER touched; that
 * asymmetry is the safety story. A web form links its upload in the same
 * user action, so a stamped file still unlinked after a day was abandoned.
 *
 * A file goes only through `claimAndRemove` (utils/upload-orphans.ts), which
 * locks its row and re-checks under the lock: stamped, linked by nothing
 * at all, older than 24 h. A form that links a day-old upload at the moment
 * of the sweep therefore either keeps the file or fails `invalid`; it never
 * keeps a link to a removed file. A tombstoned file (a removal that failed
 * after its reservation, an app's or a Media Library delete) is retried once
 * its tombstone is TOMBSTONE_RETRY_MS old and nothing links it; the retry
 * records no second audit row. Each new removal records its audit row with
 * the source `cron`.
 *
 * The candidate filter is a pure function of (rows, now) — see
 * sweep-orphaned-uploads.test.ts — the sweep itself is the thin I/O shell.
 */
import { runWithDeleteAudit } from "../utils/delete-audit";
import {
  TOMBSTONE_RETRY_MS,
  claimAndRemove,
  linkedFileIds,
  tombstoneOf,
  uploadedByOf,
} from "../utils/upload-orphans";
import { reportRunFailure } from "./run-context";

export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Removals per run (the rest follows the next night). */
export const SWEEP_MAX_PER_RUN = 1000;

export type SweepRow = {
  id: number;
  /** file row's createdAt — string/Date accepted, unparseable = not swept. */
  createdAt: string | Date | null | undefined;
  /** raw provider_metadata json of the file row. */
  providerMetadata: unknown;
};

/**
 * Pure candidate filter: which of the given files the sweep hands to
 * claimAndRemove at `now` (which re-checks everything under the lock).
 * Anything ambiguous (no uploadedBy stamp, unparseable createdAt) is
 * excluded — this function fails CLOSED, deletion is the irreversible arm.
 */
export function selectSweepCandidates(rows: SweepRow[], now: Date): number[] {
  const candidates: number[] = [];
  for (const row of rows) {
    const file = { provider_metadata: row.providerMetadata };
    // A stale reservation (a removal that failed after it) is retried
    // whoever took it, a Media Library delete of an unstamped file too.
    const tombstone = tombstoneOf(file);
    if (tombstone) {
      if (now.getTime() - tombstone.getTime() >= TOMBSTONE_RETRY_MS) candidates.push(row.id);
      continue;
    }
    if (uploadedByOf(file) === null) continue;
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt ?? "");
    if (Number.isNaN(created.getTime())) continue;
    if (now.getTime() - created.getTime() < ORPHAN_MIN_AGE_MS) continue;
    candidates.push(row.id);
  }
  return candidates;
}

/** provider_metadata as the driver returns it (an object on Postgres, JSON text on SQLite). */
function parseMetadata(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Log on every sweep that removed something, plus exactly once after boot
 * (so a freshly deployed container shows the janitor is alive) — but not
 * on every idle night, that would be log spam.
 */
let hasLoggedSinceBoot = false;

export async function sweepOrphanedUploads(strapi: any, now: Date = new Date()): Promise<void> {
  let swept = 0;
  try {
    const cutoff = new Date(now.getTime() - ORPHAN_MIN_AGE_MS);
    // SQL pre-filter (review fix N2): only STAMPED uploads, older than the
    // cutoff or tombstoned. `provider_metadata->>'uploadedBy' IS NOT NULL`
    // skips the ENTIRE admin media library, so the janitor never loads
    // every file older than 24 h into memory. The `->>` operator works on
    // Postgres and on SQLite (>= 3.38). claimAndRemove decides under the
    // lock; selectSweepCandidates only narrows.
    const rows: any[] = await strapi.db
      .getConnection("files")
      .where((query: any) =>
        query
          .where((stamped: any) =>
            stamped
              .whereRaw("provider_metadata->>'uploadedBy' IS NOT NULL")
              .where("created_at", "<", cutoff),
          )
          .orWhereRaw("provider_metadata->>'removing' IS NOT NULL"),
      )
      .orderBy("id", "asc")
      .select("id", "created_at", "provider_metadata");
    const candidates = selectSweepCandidates(
      rows.map((row) => ({
        id: Number(row.id),
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        providerMetadata: parseMetadata(row.provider_metadata),
      })),
      now,
    );
    // Linked files (most marketplace images) are no candidates; the claim
    // re-checks under the lock anyway. A read outside any transaction.
    const linked = await linkedFileIds(strapi, candidates, undefined);
    const ids = candidates.filter((id) => !linked.has(id)).slice(0, SWEEP_MAX_PER_RUN);
    await runWithDeleteAudit({ source: "cron" }, async () => {
      for (const id of ids) {
        const outcome = await claimAndRemove(strapi, id, { minAgeMs: ORPHAN_MIN_AGE_MS, now });
        if (outcome === "removed") swept += 1;
      }
    });

    if (swept > 0 || !hasLoggedSinceBoot) {
      strapi.log.info(`[uploads-janitor] swept ${swept} orphaned upload(s)`);
    }
    hasLoggedSinceBoot = true;
  } catch (err) {
    reportRunFailure(err);
    strapi.log.error(`[uploads-janitor] sweep failed: ${(err as Error).message}`);
  }
}
