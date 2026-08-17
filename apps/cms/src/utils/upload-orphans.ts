/**
 * Shared helpers for cleaning up orphaned marketplace uploads (issue #13).
 *
 * Three consumers, three safety layers:
 *  - api/classified/content-types/classified/lifecycles.ts removes an ad's
 *    images when the ad is deleted,
 *  - the classified controller's `cleanupUploads` action lets the web app
 *    sweep its own just-uploaded ids after a failed create/update,
 *  - src/cron/sweep-orphaned-uploads.ts is the nightly janitor net.
 *
 * Invariant shared by ALL consumers: only files stamped with
 * `provider_metadata.uploadedBy` (set exclusively by the hardened
 * POST /api/upload wrapper in extensions/upload/strapi-server.ts, i.e. the
 * marketplace flow) are ever deleted. Admin-panel uploads — avatars,
 * documents, wiki media — carry no stamp and are untouchable here.
 *
 * Attachment is checked against the `files_related_mph` join table (the
 * upload plugin's polymorphic relation store: file_id / related_id /
 * related_type / field). Queried via knex — there is no model UID for it.
 */

/** The uploader stamp, or null for admin uploads / pre-marketplace media. */
export function uploadedByOf(file: any): number | null {
  const stamped = (file?.provider_metadata as any)?.uploadedBy;
  return typeof stamped === "number" ? stamped : null;
}

/**
 * File ids attached to the given classifieds' `images` field. Used by the
 * delete lifecycle BEFORE the row (and its relation rows) disappears.
 */
export async function classifiedImageFileIds(
  strapi: any,
  classifiedIds: number[],
): Promise<number[]> {
  if (classifiedIds.length === 0) return [];
  // getConnection(tableName) — NOT getConnection()(tableName): with a
  // configured schema the no-arg variant returns a withSchema()-wrapped
  // builder that is not callable.
  const fileIds: number[] = await strapi.db
    .getConnection("files_related_mph")
    .where({ related_type: "api::classified.classified", field: "images" })
    .whereIn("related_id", classifiedIds)
    .pluck("file_id");
  return [...new Set(fileIds)];
}

/**
 * Which of the given files still have ANY relation row — the same image
 * can legitimately hang on two of the uploader's ads, and only a file
 * with zero remaining relations is an orphan.
 */
export async function attachedFileIds(strapi: any, fileIds: number[]): Promise<Set<number>> {
  if (fileIds.length === 0) return new Set();
  const rows: number[] = await strapi.db
    .getConnection("files_related_mph")
    .whereIn("file_id", fileIds)
    .pluck("file_id");
  return new Set(rows);
}

/**
 * Delete one file via the upload SERVICE, never raw DB — the service also
 * removes the bytes and every generated format from the provider.
 * Signature (verified in @strapi/upload 5.49, dist/server/services/
 * upload.js:535): `async function remove(file)` takes the FULL file row —
 * it reads `file.provider` (provider match guard), `file.formats`
 * (thumbnail/format deletion) and `file.id` (DB row + media-delete event).
 *
 * Errors are logged and swallowed: no caller (ad delete, cleanup endpoint,
 * janitor) may fail because one file refused to die — the janitor retries
 * nightly anyway.
 */
export async function removeUploadFile(strapi: any, file: any): Promise<boolean> {
  try {
    await strapi.plugin("upload").service("upload").remove(file);
    return true;
  } catch (err) {
    strapi.log.error(
      `[uploads-janitor] failed to remove file ${file?.id}: ${(err as Error).message}`,
    );
    return false;
  }
}
