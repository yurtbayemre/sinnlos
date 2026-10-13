/**
 * Request-scoped bridge between the wiki-page write paths and the db-level
 * lifecycle hooks, which have no access to ctx.state (contract K16 of
 * batch 16).
 *
 * The write paths wrap the Document Service call in
 * `wikiEditContext.run(...)`; everything awaited inside, including the
 * wiki-page lifecycle that records the after-image of a draft save
 * (api/wiki-page/content-types/wiki-page/lifecycles.ts), reads the store
 * through `wikiEditContext.getStore()`:
 *   - `editorId`: the users-permissions user who saves (the history's
 *     editor); panel saves carry none and are attributed to the admin user
 *     of the request instead (`adminEditorId`, never `data.updatedBy`);
 *   - `revisionSummary`: the optional edit note, stored as the revision's
 *     `summary` (the API calls it `changeSummary`);
 *   - `restoredFrom`: the id of the revision a restore brings back. A save
 *     with it is always recorded, even when its content equals the latest
 *     snapshot, and the new revision names it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface WikiEditContext {
  editorId?: number;
  revisionSummary?: string;
  restoredFrom?: number;
}

export const wikiEditContext = new AsyncLocalStorage<WikiEditContext>();
