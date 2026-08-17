/**
 * Nightly janitor for orphaned marketplace uploads (issue #13, option 3).
 *
 * The two-step web flow (upload → create) can strand files despite the
 * best-effort cleanup endpoint (web container dies between the steps,
 * cleanup POST itself fails, …). This sweep is the net under the net:
 * daily at 03:30 Europe/Berlin (wired in config/server.ts; after the
 * 03:00 pg-backup so a swept file is always in the previous backup).
 *
 * A file is swept ONLY when ALL three hold:
 *  - `provider_metadata.uploadedBy` is set — the stamp written exclusively
 *    by the hardened POST /api/upload marketplace route. Admin uploads
 *    (avatars, documents, wiki media) carry no stamp and are NEVER
 *    touched; that asymmetry is the entire safety story.
 *  - no relation row in files_related_mph — not attached to anything.
 *  - older than 24 h — a create/cleanup that is merely in flight right now
 *    is never raced.
 *
 * The decision is a pure function of (rows, now) — see
 * sweep-orphaned-uploads.test.ts — the sweep itself is the thin I/O shell.
 */
import { attachedFileIds, removeUploadFile, uploadedByOf } from "../utils/upload-orphans";

export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type SweepRow = {
  id: number;
  /** file row's createdAt — string/Date accepted, unparseable = not swept. */
  createdAt: string | Date | null | undefined;
  /** raw provider_metadata json of the file row. */
  providerMetadata: unknown;
  /** true when files_related_mph still holds a row for this file. */
  attached: boolean;
};

/**
 * Pure candidate filter: which of the given files may be deleted at `now`.
 * Anything ambiguous (no uploadedBy stamp, unparseable createdAt) is
 * excluded — this function fails CLOSED, deletion is the irreversible arm.
 */
export function selectSweepCandidates(rows: SweepRow[], now: Date): number[] {
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
  const candidates: number[] = [];
  for (const row of rows) {
    if (row.attached) continue;
    const uploadedBy = (row.providerMetadata as any)?.uploadedBy;
    if (typeof uploadedBy !== "number") continue;
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt ?? "");
    if (Number.isNaN(created.getTime())) continue;
    if (created.getTime() > cutoff) continue;
    candidates.push(row.id);
  }
  return candidates;
}

/**
 * Log on every sweep that removed something, plus exactly once after boot
 * (so a freshly deployed container shows the janitor is alive) — but not
 * on every idle night, that would be log spam.
 */
let hasLoggedSinceBoot = false;

export async function sweepOrphanedUploads(strapi: any): Promise<void> {
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - ORPHAN_MIN_AGE_MS);
    // SQL pre-filter (review fix N2): only STAMPED marketplace uploads older
    // than the cutoff. `provider_metadata->>'uploadedBy' IS NOT NULL` skips
    // the ENTIRE admin media library (avatars, documents, wiki media carry no
    // stamp), so the janitor no longer loads every file older than 24 h into
    // memory — only the handful of marketplace uploads. Verified against the
    // live Postgres 16 `files` table on 2026-08-17; the `->>` operator is also
    // supported by the standalone SQLite (>= 3.38). The authoritative
    // stamp/age check still lives in the pure selectSweepCandidates below.
    const candidateIds: number[] = await strapi.db
      .getConnection("files")
      .whereRaw("provider_metadata->>'uploadedBy' IS NOT NULL")
      .where("created_at", "<", cutoff)
      .pluck("id");

    let swept = 0;
    if (candidateIds.length > 0) {
      const attached = await attachedFileIds(strapi, candidateIds);
      const orphanIds = candidateIds.filter((id) => !attached.has(id));
      // Load full rows only for the (small) orphan set — remove() needs the
      // whole file row (provider, formats, hash, ext, id).
      const files: any[] = orphanIds.length
        ? await strapi.db
            .query("plugin::upload.file")
            .findMany({ where: { id: { $in: orphanIds } } })
        : [];
      const byId = new Map<number, any>(files.map((file) => [file.id, file]));
      const sweepIds = selectSweepCandidates(
        files.map((file) => ({
          id: file.id,
          createdAt: file.createdAt,
          providerMetadata: file.provider_metadata,
          attached: false,
        })),
        now,
      );
      for (const id of sweepIds) {
        const file = byId.get(id);
        if (!file || uploadedByOf(file) === null) continue;
        if (await removeUploadFile(strapi, file)) swept += 1;
      }
    }

    if (swept > 0 || !hasLoggedSinceBoot) {
      strapi.log.info(`[uploads-janitor] swept ${swept} orphaned upload(s)`);
    }
    hasLoggedSinceBoot = true;
  } catch (err) {
    strapi.log.error(`[uploads-janitor] sweep failed: ${(err as Error).message}`);
  }
}
