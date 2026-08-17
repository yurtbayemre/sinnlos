/**
 * Delete an ad's images together with the ad (issue #13).
 *
 * Classifieds are the only content type whose media is user-generated and
 * throwaway: without this hook every deleted (or admin-moderated) ad left
 * its photos in the media library forever — employees hold no
 * upload.destroy permission by design.
 *
 * Flow (entity-manager delete, @strapi/database 5.49
 * dist/entity-manager/index.js:362-399): beforeDelete → row delete →
 * deleteRelations → afterDelete. So:
 *  - beforeDelete records the file ids hanging on the ad's `images` while
 *    the relation rows still exist (event.state carries them over — the
 *    lifecycle runner shares one state object per subscriber+operation),
 *  - afterDelete removes every recorded file that (a) carries the
 *    marketplace stamp `provider_metadata.uploadedBy` — admin uploads
 *    (avatars, documents) are NEVER touched — and (b) has no remaining
 *    relation row (the same image can hang on two of the uploader's ads;
 *    this ad's own rows are already gone by now).
 *
 * TRANSACTION TIMING (review fix K2) — the document-service wraps the whole
 * delete in ONE transaction (verified in @strapi/core 5.49
 * document-service/common.js:4 → `strapi.db.transaction`), and afterDelete
 * still runs INSIDE it, before commit. deleteRelations' row removals are thus
 * not yet committed. Re-checking attachment on a separate pool connection (as
 * attachedFileIds does — getConnection is not the ambient trx) would, under
 * Postgres READ COMMITTED, still see every just-deleted relation row → each
 * file looks attached → nothing is ever swept. So the attachment re-check +
 * removal are deferred to `onCommit` (the same pattern Strapi itself uses for
 * post-commit work in document-service/events.js:46): they run once the
 * transaction has committed, against the real orphan state. When there is no
 * outer transaction the nested strapi.db.transaction commits immediately and
 * the callback fires right after — correct in both cases.
 *
 * The Many-variants (beforeDeleteMany/afterDeleteMany) are deliberately
 * NOT implemented: the core REST delete path resolves to the SINGULAR
 * db.query().delete() per entry (documents-service entries.delete), and
 * deleteMany skips deleteRelations entirely (upstream TODO,
 * entity-manager index.js:401) — its stale relation rows would make the
 * "no remaining relations" check undecidable. A hypothetical bulk script
 * delete leaves files for the nightly janitor instead.
 *
 * File removal errors are logged, never thrown — the ad delete must not
 * fail because a file refused to die; the janitor retries nightly.
 */
import {
  attachedFileIds,
  classifiedImageFileIds,
  removeUploadFile,
  uploadedByOf,
} from "../../../../utils/upload-orphans";

export default {
  async beforeDelete(event: any) {
    try {
      const where = event.params?.where;
      if (!where) return;
      const rows = await strapi.db
        .query("api::classified.classified")
        .findMany({ where, select: ["id"] });
      event.state.imageFileIds = await classifiedImageFileIds(
        strapi,
        rows.map((row: any) => row.id),
      );
    } catch (err) {
      // Fail open: a broken pre-scan must not block the delete; the
      // janitor sweeps whatever this misses.
      strapi.log.error(
        `[uploads-janitor] classified beforeDelete scan failed: ${(err as Error).message}`,
      );
    }
  },

  async afterDelete(event: any) {
    const fileIds: number[] = event.state?.imageFileIds ?? [];
    if (fileIds.length === 0) return;
    // Defer the orphan re-check + removal until AFTER the delete transaction
    // commits (see the TRANSACTION TIMING note in the file header). A nested
    // strapi.db.transaction reuses the ambient trx and registers onCommit on
    // it; with no ambient trx it commits at once and the callback fires
    // immediately. The callback is self-contained (its own try/catch) — the
    // ad delete must never fail because a file refused to die.
    await strapi.db.transaction(({ onCommit }: { onCommit: (cb: () => void) => void }) => {
      onCommit(async () => {
        try {
          const stillAttached = await attachedFileIds(strapi, fileIds);
          let removed = 0;
          for (const fileId of fileIds) {
            if (stillAttached.has(fileId)) continue;
            const file = await strapi.db
              .query("plugin::upload.file")
              .findOne({ where: { id: fileId } });
            if (!file || uploadedByOf(file) === null) continue;
            if (await removeUploadFile(strapi, file)) removed += 1;
          }
          if (removed > 0) {
            strapi.log.info(`[uploads-janitor] removed ${removed} image(s) of deleted classified`);
          }
        } catch (err) {
          strapi.log.error(
            `[uploads-janitor] classified afterDelete cleanup failed: ${(err as Error).message}`,
          );
        }
      });
    });
  },
};
