/**
 * Removing uploaded files: ONE locked removal for every path (deep-dive
 * decision 06 §E3-§E5; batch 16 plan item 4, contract K12; issue #13).
 *
 * WHO REMOVES. Every remover goes through `claimAndRemove`:
 *   - the classified delete lifecycle (an ad's images after the ad delete),
 *   - the classified controller's `cleanup-uploads` (the web sweeps its own
 *     just-uploaded ids after a failed create or update),
 *   - the nightly `uploads-janitor` (cron/sweep-orphaned-uploads.ts),
 *   - the media claims (utils/media-claims.ts: a stamped file a document
 *     no longer links after any Document Service action).
 * The admin Media Library deletes through the upload service directly
 * (Strapi's own behaviour); its deletes are recorded like these
 * (utils/delete-audit.ts).
 *
 * THE INVARIANT shared by all of them: only files stamped with
 * `provider_metadata.uploadedBy` (set exclusively by the hardened
 * POST /api/upload wrapper, extensions/upload/strapi-server.ts) are ever
 * removed, and only when nothing links them (`files_related_mph`, any
 * related type, any field: the same image may hang on two of one author's
 * ads, a document's draft and published rows share their file).
 * Admin-panel uploads carry no stamp and are never touched here.
 *
 * THE PROTOCOL (`claimAndRemove`):
 *   1. a short transaction locks the file row (`FOR UPDATE`; SQLite has one
 *      writer), re-reads it and re-checks under the lock: still there,
 *      stamped (by `ownerId` when given), old enough (`minAgeMs`), linked by
 *      nothing; it then COMMITS A TOMBSTONE (`provider_metadata.removing`,
 *      an ISO timestamp);
 *   2. only then the upload service's `remove` deletes the bytes and the
 *      row (in that order, @strapi/upload 5.57 services/upload.js), with
 *      its audit row in one transaction (strapi-server.ts).
 * A failure in step 2 leaves a tombstoned row, never an attachable row
 * without bytes: every attach path refuses a tombstoned file (the media
 * claims, the classified attachment; 16B's `ownUploadCheck` through
 * `isTombstoned`), and the janitor retries tombstoned rows after
 * TOMBSTONE_RETRY_MS (the local provider's delete of missing bytes
 * succeeds, upload-validation.contract.test.ts). An attach that locks the
 * row first wins, and the claim then sees its link and removes nothing.
 *
 * Every raw link read joins the caller's transaction (`trx`): a read on
 * the pool would wait for the very transaction it runs in on SQLite (one
 * connection; FX45) and escape it on Postgres.
 */
import { runWithDeleteAudit } from "./delete-audit";

export const FILE_UID = "plugin::upload.file";

/** How long a tombstone may stand before the janitor retries its removal. */
export const TOMBSTONE_RETRY_MS = 10 * 60 * 1000;

export const UPLOADS_LOG = "[uploads]";

/** The uploader stamp, or null for admin uploads / pre-marketplace media. */
export function uploadedByOf(file: any): number | null {
  const stamped = (file?.provider_metadata as any)?.uploadedBy;
  return typeof stamped === "number" ? stamped : null;
}

/** When the file was claimed for removal (its tombstone), or null. */
export function tombstoneOf(file: any): Date | null {
  const removing = (file?.provider_metadata as any)?.removing;
  if (typeof removing !== "string") return null;
  const at = new Date(removing);
  return Number.isNaN(at.getTime()) ? new Date(0) : at;
}

/** A tombstoned file is on its way out: no attach path may link it. */
export function isTombstoned(file: any): boolean {
  return tombstoneOf(file) !== null;
}

/** A knex builder of `files_related_mph`, joined to `trx` when given. */
function links(strapi: any, trx: unknown) {
  // getConnection(tableName) — NOT getConnection()(tableName): with a
  // configured schema the no-arg variant returns a withSchema()-wrapped
  // builder that is not callable.
  const query = strapi.db.getConnection("files_related_mph");
  return trx ? query.transacting(trx) : query;
}

/**
 * File ids attached to the given classifieds' `images` field. Used by the
 * delete lifecycle BEFORE the row (and its relation rows) disappears; `trx`
 * is the delete's transaction (FX45).
 */
export async function classifiedImageFileIds(
  strapi: any,
  classifiedIds: number[],
  trx?: unknown,
): Promise<number[]> {
  if (classifiedIds.length === 0) return [];
  const fileIds: number[] = await links(strapi, trx)
    .where({ related_type: "api::classified.classified", field: "images" })
    .whereIn("related_id", classifiedIds)
    .pluck("file_id");
  return [...new Set(fileIds)];
}

/** Which of the given files any row links (any related type, any field). */
export async function linkedFileIds(
  strapi: any,
  fileIds: number[],
  trx: unknown,
): Promise<Set<number>> {
  if (fileIds.length === 0) return new Set();
  const rows: number[] = await links(strapi, trx).whereIn("file_id", fileIds).pluck("file_id");
  return new Set(rows.map(Number));
}

/** The rows linking one file (`related_type`, `related_id`), for the delete trail. */
export async function fileLinks(
  strapi: any,
  fileId: number,
  trx: unknown,
): Promise<Array<{ relatedType: string; relatedId: number }>> {
  const rows: Array<{ related_type: string; related_id: number }> = await links(strapi, trx)
    .where({ file_id: fileId })
    .select("related_type", "related_id");
  return rows.map((row) => ({ relatedType: row.related_type, relatedId: Number(row.related_id) }));
}

/**
 * Locks one file row until the ambient transaction ends (`FOR UPDATE` on
 * Postgres; SQLite has one writer). File rows come last in the lock order
 * (§5 R10): a caller locks several in ascending id order.
 */
export async function lockFileRow(strapi: any, fileId: number): Promise<void> {
  await strapi.db.queryBuilder(FILE_UID).select(["id"]).where({ id: fileId }).forUpdate().execute();
}

export interface ClaimOptions {
  /** Only a file stamped by this user (cleanup-uploads: the caller's own). */
  ownerId?: number;
  /** Only a file at least this old (the janitor: 24 h). */
  minAgeMs?: number;
  /** Retry a tombstone at least this old (the janitor); otherwise a tombstoned file is skipped. */
  retryTombstoneAfterMs?: number;
  /** The document the file belonged to, for the delete trail. */
  related?: { uid: string; documentId: string };
  now?: Date;
}

export type ClaimOutcome =
  "removed" | "missing" | "unstamped" | "foreign" | "young" | "linked" | "removing" | "failed";

/** The decision under the lock (pure; claimAndRemove's re-check). */
export function claimDecision(
  file: any,
  linked: boolean,
  options: ClaimOptions,
  now: Date,
): Exclude<ClaimOutcome, "removed" | "failed"> | "claim" {
  if (!file) return "missing";
  const owner = uploadedByOf(file);
  if (owner === null) return "unstamped";
  if (options.ownerId !== undefined && owner !== options.ownerId) return "foreign";
  const tombstone = tombstoneOf(file);
  if (tombstone) {
    const retry = options.retryTombstoneAfterMs;
    if (retry === undefined || now.getTime() - tombstone.getTime() < retry) return "removing";
  } else if (options.minAgeMs !== undefined) {
    const created = new Date(file.createdAt ?? file.created_at ?? "");
    if (Number.isNaN(created.getTime())) return "young";
    if (now.getTime() - created.getTime() < options.minAgeMs) return "young";
  }
  if (linked) return "linked";
  return "claim";
}

/**
 * The one locked removal (see the module comment). Must run outside any
 * transaction (after a commit, in a cron, in a request): its claim commits
 * on its own. Never throws: a failed removal is logged and answers
 * "failed" (the tombstone stays for the janitor).
 */
export async function claimAndRemove(
  strapi: any,
  fileId: number,
  options: ClaimOptions = {},
): Promise<ClaimOutcome> {
  if (strapi.db.inTransaction()) {
    throw new Error(`${UPLOADS_LOG} claimAndRemove must run outside a transaction`);
  }
  const now = options.now ?? new Date();
  let claimed: any;
  try {
    const decision = await strapi.db.transaction(async ({ trx }: { trx: unknown }) => {
      await lockFileRow(strapi, fileId);
      const file = await strapi.db.query(FILE_UID).findOne({ where: { id: fileId } });
      const linked = file ? (await linkedFileIds(strapi, [fileId], trx)).has(fileId) : false;
      const verdict = claimDecision(file, linked, options, now);
      if (verdict !== "claim") return verdict;
      if (!tombstoneOf(file)) {
        const provider_metadata = { ...file.provider_metadata, removing: now.toISOString() };
        await strapi.db
          .query(FILE_UID)
          .update({ where: { id: fileId }, data: { provider_metadata } });
        claimed = { ...file, provider_metadata };
      } else {
        claimed = file;
      }
      return "claim";
    });
    if (decision !== "claim") return decision;
  } catch (err) {
    strapi.log.error(`${UPLOADS_LOG} could not claim file ${fileId}: ${(err as Error).message}`);
    return "failed";
  }
  try {
    await runWithDeleteAudit(options.related ? { related: options.related } : {}, () =>
      strapi.plugin("upload").service("upload").remove(claimed),
    );
    return "removed";
  } catch (err) {
    strapi.log.error(
      `${UPLOADS_LOG} could not remove file ${fileId} (tombstoned; the janitor retries): ${(err as Error).message}`,
    );
    return "failed";
  }
}
