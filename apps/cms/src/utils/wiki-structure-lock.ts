import { lockDocument, type DocumentLockHost } from "./document-lock";

/**
 * The wiki structure lock (deep-dive plan batch 16, S2 and S15; contract
 * K21): ONE reserved version row, `content_versions` (target_uid
 * `sinnlos::wiki-structure`, target_document_id `global`), taken through
 * the document lock's `lockDocument`, which ensures the row and locks it
 * `FOR UPDATE` on Postgres (SQLite has one writer). The lock holds until
 * the transaction ends.
 *
 * WHO TAKES IT: the wiki checks (utils/wiki-checks.ts, Document Service
 * middleware slot 4), from every source (content API, Content Manager single
 * and bulk, the scheduler, boot writers), on
 *   - every mutating wiki-page action: create, update, clone, publish,
 *     unpublish, discardDraft, delete (publish and discard re-create the
 *     incoming self-referential links of other pages, so they can close a
 *     parent loop too);
 *   - a wiki-space delete, unpublish and discardDraft (a discard that
 *     deletes a never-published space).
 * So two writers can never commit a parent loop between them, and no page
 * lands in a space that is being deleted, whichever spaces they touch. One
 * row instead of a lock per space (the decision's §G2): a loop can run
 * through pages of four spaces, which no set of per-space locks would see.
 *
 * LOCK ORDER (§5 R10). A transaction takes the version rows in this order:
 *   1. the document's own version row (the document lock, slot 2);
 *   2. other version rows in ascending (target_uid, target_document_id);
 *      `sinnlos::wiki-structure` sorts after every `api::` uid, so the
 *      structure row comes after any content document's row;
 *   3. file rows in ascending id (the media claims, slot 7).
 * Target-row locks sit OUTSIDE this order: a department or team delete
 * locks its own rows `FOR UPDATE` and then the linked documents' version
 * rows (utils/targeting-flags.ts), while inserting a link to a department
 * takes `FOR KEY SHARE` on that row. With wiki pages in the delete's set, a
 * page save waiting for the structure lock, a save holding it that links
 * the department, and the department's delete can deadlock; Postgres then
 * aborts one of them (40P01) and rolls it back whole. Accepted for these
 * rare admin deletes, as batch 15 accepts it for announcements.
 *
 * TIME-BOUNDED: the critical section is a few reads of the parent links
 * (wiki-checks.ts) around one Document Service action, milliseconds at
 * intranet scale; it never walks a chain under a second lock.
 */

/** The `target_uid` of the reserved lock row. Not a content type: never a Document Service uid. */
export const WIKI_STRUCTURE_LOCK_UID = "sinnlos::wiki-structure";

/** The `target_document_id` of the reserved lock row. */
export const WIKI_STRUCTURE_LOCK_DOCUMENT_ID = "global";

/**
 * Inside a transaction: takes the wiki structure lock (see the module
 * comment) and returns once it is held. Throws outside a transaction, where
 * a lock would end at once.
 */
export async function lockWikiStructure(strapi: DocumentLockHost): Promise<void> {
  await lockDocument(strapi, WIKI_STRUCTURE_LOCK_UID, WIKI_STRUCTURE_LOCK_DOCUMENT_ID);
}
