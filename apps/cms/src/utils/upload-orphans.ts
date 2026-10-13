/**
 * Removing uploaded files: ONE reservation for every removal (deep-dive
 * decision 06 §E3-§E5; batch 16 plan item 4, contract K12; issue #13).
 *
 * WHO REMOVES.
 *   - The app's removers go through `claimAndRemove`, which adds the app's
 *     rules (stamped, by the owner when given, old enough, linked by
 *     nothing): the classified delete lifecycle (an ad's images after the ad
 *     delete), the classified controller's `cleanup-uploads` (the web sweeps
 *     its own just-uploaded ids after a failed create or update), the
 *     nightly `uploads-janitor` (cron/sweep-orphaned-uploads.ts) and the
 *     media claims (utils/media-claims.ts).
 *   - The admin Media Library (single, bulk and folder deletes) calls the
 *     upload service's `remove` directly; extensions/upload/strapi-server.ts
 *     wraps it so it takes the same reservation, without the app's rules (an
 *     admin may delete any file, linked or not, stamped or not).
 *
 * THE RESERVATION (`reserveRemoval`), one short transaction that commits
 * on its own:
 *   1. lock the file row (`FOR UPDATE`; SQLite has one writer) and re-read
 *      it: a file that is gone, or that another removal reserved less than
 *      TOMBSTONE_RETRY_MS ago, is skipped (two overlapping deletes remove
 *      and record it once);
 *   2. re-check the caller's rules under the lock;
 *   3. write the TOMBSTONE (`provider_metadata.removing`, an ISO timestamp)
 *      and the delete's AUDIT ROW (utils/delete-audit.ts), and commit.
 * Only then does the upload service delete the bytes and the row (in that
 * order, @strapi/upload 5.57 services/upload.js). A failure in between
 * leaves a tombstoned row, never an attachable row without bytes: every
 * attach path refuses a tombstoned file (the media claims, the classified
 * write lifecycle; 16B's `ownUploadCheck` through `isTombstoned`), the
 * janitor retries an unlinked tombstoned row once its tombstone is older
 * than TOMBSTONE_RETRY_MS, and an admin can delete it again after that
 * (the local provider's delete of missing bytes succeeds,
 * upload-validation.contract.test.ts). A retry completes the reservation:
 * it records no second row. The audit row therefore records the decision
 * to delete, attributed to whoever took it; from then on the file is
 * unattachable and its removal is retried until done.
 *
 * THE INVARIANT of the app's removers: only files stamped with
 * `provider_metadata.uploadedBy` (set exclusively by the hardened
 * POST /api/upload wrapper) are removed, and only when nothing links them
 * (`files_related_mph`, any related type, any field: the same image may
 * hang on two of one author's ads, a document's draft and published rows
 * share their file). Admin-panel uploads carry no stamp and are never
 * touched by the app. An attach that locks the row first wins, and the
 * claim then sees its link and removes nothing.
 *
 * Every raw link read joins the caller's transaction (`trx`): a read on
 * the pool would wait for the very transaction it runs in on SQLite (one
 * connection; FX45) and escape it on Postgres.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { recordDelete, runWithDeleteAudit } from "./delete-audit";

export const FILE_UID = "plugin::upload.file";

/** How long a reservation may stand before another remover may retry it. */
export const TOMBSTONE_RETRY_MS = 10 * 60 * 1000;

export const UPLOADS_LOG = "[uploads]";

/** The uploader stamp, or null for admin uploads / pre-marketplace media. */
export function uploadedByOf(file: any): number | null {
  const stamped = (file?.provider_metadata as any)?.uploadedBy;
  return typeof stamped === "number" ? stamped : null;
}

/** When the file was reserved for removal (its tombstone), or null. */
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

/** The media references a value names: row ids and documentIds. */
export interface MediaReferences {
  ids: number[];
  documentIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A row id as Strapi coerces one (`Number`): " 1", "+1" and "1.0" are id 1. */
function asRowId(item: unknown): number | null {
  if (typeof item !== "number" && typeof item !== "string") return null;
  if (typeof item === "string" && item.trim() === "") return null;
  const id = Number(item);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

/**
 * Every media reference in a relation value as Strapi 5.57 accepts it: a
 * row id (a number, or a string Strapi coerces to one: " 1", "+1"), a
 * documentId (any other string; a string that is not only digits is read
 * both ways, Codex round 3), `{ id }`, `{ documentId }`, lists, and
 * `connect`/`set` lists. Anything else is ignored.
 */
export function mediaReferences(value: unknown): MediaReferences {
  const ids = new Set<number>();
  const documentIds = new Set<string>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 4 || item === null || item === undefined) return;
    const id = asRowId(item);
    if (id !== null) ids.add(id);
    if (typeof item === "number") return;
    if (typeof item === "string") {
      if (item !== "" && !/^\d+$/.test(item)) documentIds.add(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, depth + 1);
      return;
    }
    if (isRecord(item)) {
      if ("id" in item) visit(item.id, depth + 1);
      if (typeof item.documentId === "string" && item.documentId !== "") {
        documentIds.add(item.documentId);
      }
      if ("connect" in item) visit(item.connect, depth + 1);
      if ("set" in item) visit(item.set, depth + 1);
    }
  };
  visit(value, 0);
  return { ids: [...ids], documentIds: [...documentIds] };
}

/** The file row ids `references` name, ascending (documentIds resolved; unknown ones dropped). */
export async function resolveFileIds(strapi: any, references: MediaReferences): Promise<number[]> {
  const ids = new Set(references.ids);
  if (references.documentIds.length > 0) {
    const rows: Array<{ id: number }> = await strapi.db.query(FILE_UID).findMany({
      where: { documentId: { $in: references.documentIds } },
      select: ["id"],
    });
    for (const row of rows) ids.add(row.id);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Locks the files `fileIds` (ascending) and answers whether every one of
 * them exists and is not tombstoned: the attach paths' check before they
 * write a link (the media claims, the classified write lifecycle). Inside
 * the caller's transaction.
 */
export async function lockAttachableFiles(strapi: any, fileIds: number[]): Promise<boolean> {
  let attachable = true;
  for (const fileId of [...fileIds].sort((a, b) => a - b)) {
    await lockFileRow(strapi, fileId);
    const file = await strapi.db.query(FILE_UID).findOne({ where: { id: fileId } });
    if (!file || isTombstoned(file)) attachable = false;
  }
  return attachable;
}

export type ClaimOutcome =
  "removed" | "missing" | "unstamped" | "foreign" | "young" | "linked" | "removing" | "failed";

/** A reservation's rules: "claim", or why the file stays. */
export type ReservationCheck = (
  file: any,
  linked: boolean,
  retrying: boolean,
) => Exclude<ClaimOutcome, "removed" | "failed"> | "claim";

/** The upload service's `remove(file)` of the reserved row runs inside this. */
const reservedRemoval = new AsyncLocalStorage<number>();

/** True inside the removal of `fileId` that `reserveRemoval` reserved (strapi-server.ts). */
export function isReservedRemoval(fileId: unknown): boolean {
  return reservedRemoval.getStore() === fileId;
}

/** Runs the upload service's removal of a reserved file. */
export function runReservedRemoval<T>(fileId: number, fn: () => T): T {
  return reservedRemoval.run(fileId, fn);
}

/**
 * The reservation (see the module comment): locks and re-reads the row,
 * skips a missing file or a fresh tombstone, applies `check`, writes the
 * tombstone and the audit row, and commits. Returns the reserved row, or
 * why the file stays. A stale tombstone (an earlier removal that failed
 * after its reservation) is taken over without a second audit row.
 */
export async function reserveRemoval(
  strapi: any,
  fileId: number,
  check: ReservationCheck = () => "claim",
  now: Date = new Date(),
): Promise<{ file: any } | { outcome: Exclude<ClaimOutcome, "removed" | "failed"> }> {
  return strapi.db.transaction(async ({ trx }: { trx: unknown }) => {
    await lockFileRow(strapi, fileId);
    const file = await strapi.db.query(FILE_UID).findOne({ where: { id: fileId } });
    if (!file) return { outcome: "missing" as const };
    const tombstone = tombstoneOf(file);
    if (tombstone && now.getTime() - tombstone.getTime() < TOMBSTONE_RETRY_MS) {
      return { outcome: "removing" as const };
    }
    const linkRows = await fileLinks(strapi, fileId, trx);
    const verdict = check(file, linkRows.length > 0, tombstone !== null);
    if (verdict !== "claim") return { outcome: verdict };
    const provider_metadata = { ...file.provider_metadata, removing: now.toISOString() };
    await strapi.db.query(FILE_UID).update({ where: { id: fileId }, data: { provider_metadata } });
    // The delete's audit row commits with the reservation; a retry of a
    // stale one records nothing new.
    if (!tombstone) await recordDelete(strapi, { kind: "file", file, links: linkRows });
    return { file: { ...file, provider_metadata } };
  });
}

export interface ClaimOptions {
  /** Only a file stamped by this user (cleanup-uploads: the caller's own). */
  ownerId?: number;
  /** Only a file at least this old (the janitor: 24 h); a retried reservation is exempt. */
  minAgeMs?: number;
  /** The document the file belonged to, for the delete trail. */
  related?: { uid: string; documentId: string };
  now?: Date;
}

/**
 * The app's rules under the lock (pure): stamped, by the owner when given,
 * old enough, linked by nothing. Retrying a stale reservation (`retrying`)
 * re-checks only the links.
 */
export function claimDecision(
  file: any,
  linked: boolean,
  options: ClaimOptions,
  now: Date,
  retrying = false,
): Exclude<ClaimOutcome, "removed" | "failed"> | "claim" {
  if (!file) return "missing";
  if (!retrying) {
    const owner = uploadedByOf(file);
    if (owner === null) return "unstamped";
    if (options.ownerId !== undefined && owner !== options.ownerId) return "foreign";
    if (options.minAgeMs !== undefined) {
      const created = new Date(file.createdAt ?? file.created_at ?? "");
      if (Number.isNaN(created.getTime())) return "young";
      if (now.getTime() - created.getTime() < options.minAgeMs) return "young";
    }
  }
  if (linked) return "linked";
  return "claim";
}

/**
 * The app's locked removal (see the module comment). Must run outside any
 * transaction (after a commit, in a cron, in a request): its reservation
 * commits on its own. Never throws: a failed removal is logged and answers
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
  return runWithDeleteAudit(options.related ? { related: options.related } : {}, async () => {
    let reserved: Awaited<ReturnType<typeof reserveRemoval>>;
    try {
      reserved = await reserveRemoval(
        strapi,
        fileId,
        (file, linked, retrying) => claimDecision(file, linked, options, now, retrying),
        now,
      );
    } catch (err) {
      strapi.log.error(
        `${UPLOADS_LOG} could not reserve file ${fileId}: ${(err as Error).message}`,
      );
      return "failed";
    }
    if (!("file" in reserved)) return reserved.outcome;
    try {
      await runReservedRemoval(fileId, () =>
        strapi.plugin("upload").service("upload").remove(reserved.file),
      );
      return "removed";
    } catch (err) {
      strapi.log.error(
        `${UPLOADS_LOG} could not remove file ${fileId} (tombstoned; the janitor retries): ${(err as Error).message}`,
      );
      return "failed";
    }
  });
}
