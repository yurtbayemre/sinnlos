/**
 * An ad's delete: its audit row, and its images after the commit (issue
 * #13; batch 16 lane 16A: the delete trail and the one locked removal).
 *
 * Classifieds are the only content type whose media is user-generated and
 * throwaway: without this hook every deleted (or admin-moderated) ad left
 * its photos in the media library forever — employees hold no
 * upload.destroy permission by design.
 *
 * Flow (entity-manager delete, @strapi/database 5.57
 * dist/entity-manager/index.js): beforeDelete → row delete →
 * deleteRelations → afterDelete, all inside the Document Service's
 * transaction (document-service/common.js `wrapInTransaction`). So:
 *  - beforeDelete records ONE AUDIT ROW per ad (utils/delete-audit.ts:
 *    who, from where, the ad's documentId and title) inside that
 *    transaction, for every source (the author or a moderator through the
 *    API, the Content Manager, the nightly classified-janitor). The insert
 *    is not caught: a failing insert fails the delete, so no ad goes
 *    unrecorded (batch 15's rule for the trail);
 *  - beforeDelete also records the file ids hanging on the ad's `images`
 *    while the relation rows still exist (event.state carries them over —
 *    the lifecycle runner shares one state object per subscriber+operation);
 *  - afterDelete hands every recorded file to `claimAndRemove`
 *    (utils/upload-orphans.ts) AFTER the commit (utils/after-commit.ts):
 *    it locks the file row and removes only a stamped file that nothing
 *    links any more (the same image can hang on two of the uploader's
 *    ads); admin uploads (avatars, documents) are never touched. Each
 *    removal records its own audit row, linked to the ad and attributed to
 *    whoever deleted the ad (the commit callback keeps the request context).
 *
 * TRANSACTION TIMING (review fix K2): the attachment re-check runs after
 * the commit, against the real orphan state; under Postgres READ COMMITTED
 * a check inside the delete's transaction from another connection would
 * still see the just-deleted relation rows.
 *
 * The Many-variants (beforeDeleteMany/afterDeleteMany) are deliberately
 * NOT implemented: the Document Service and the Content Manager (also its
 * bulk delete) resolve to the SINGULAR db.query().delete() per entry, and
 * deleteMany skips deleteRelations entirely (upstream TODO) — its stale
 * relation rows would make the "no remaining relations" check
 * undecidable. A hypothetical bulk script delete leaves files for the
 * nightly janitor, and goes unrecorded.
 *
 * File removal errors are logged, never thrown — the ad delete must not
 * fail because a file refused to die; the janitor retries nightly.
 */
import { afterCommit } from "../../../../utils/after-commit";
import { CLASSIFIED_UID, recordDelete, runWithDeleteAudit } from "../../../../utils/delete-audit";
import { classifiedImageFileIds, claimAndRemove } from "../../../../utils/upload-orphans";

/** An image of a deleted ad, recorded before the relation rows go. */
interface DeletedImage {
  fileId: number;
  adDocumentId: string;
}

export default {
  async beforeDelete(event: any) {
    const where = event.params?.where;
    if (!where) return;
    // Joins the delete's transaction (the query engine reuses the ambient
    // one); a failing read or insert fails the delete.
    const ads: Array<{ id: number; documentId: string; title?: unknown }> = await strapi.db
      .query(CLASSIFIED_UID)
      .findMany({ where, select: ["id", "documentId", "title"] });
    for (const ad of ads) {
      await recordDelete(strapi, {
        kind: "classified",
        documentId: ad.documentId,
        title: ad.title,
      });
    }
    try {
      // FX45: the raw join-table read joins the delete's own transaction. A
      // nested strapi.db.transaction hands out the ambient trx (and commits
      // nothing); on SQLite, whose pool holds exactly one connection, a read
      // on the pool waited 60 s behind this very transaction and failed open.
      const images: DeletedImage[] = await strapi.db.transaction(
        async ({ trx }: { trx: unknown }) => {
          const out: DeletedImage[] = [];
          for (const ad of ads) {
            for (const fileId of await classifiedImageFileIds(strapi, [ad.id], trx)) {
              out.push({ fileId, adDocumentId: ad.documentId });
            }
          }
          return out;
        },
      );
      event.state.images = images;
    } catch (err) {
      // Fail open: a broken pre-scan must not block the delete; the
      // janitor sweeps whatever this misses.
      strapi.log.error(
        `[uploads-janitor] classified beforeDelete scan failed: ${(err as Error).message}`,
      );
    }
  },

  async afterDelete(event: any) {
    const images: DeletedImage[] = event.state?.images ?? [];
    if (images.length === 0) return;
    await afterCommit(
      strapi.db,
      async () => {
        let removed = 0;
        for (const { fileId, adDocumentId } of images) {
          const outcome = await runWithDeleteAudit(
            { related: { uid: CLASSIFIED_UID, documentId: adDocumentId } },
            () => claimAndRemove(strapi, fileId),
          );
          if (outcome === "removed") removed += 1;
        }
        if (removed > 0) {
          strapi.log.info(`[uploads-janitor] removed ${removed} image(s) of deleted classified`);
        }
      },
      (err) =>
        strapi.log.error(
          `[uploads-janitor] classified afterDelete cleanup failed: ${(err as Error).message}`,
        ),
    );
  },
};
