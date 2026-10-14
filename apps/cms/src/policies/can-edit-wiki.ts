import { wikiPageGate } from "../utils/wiki-gate";

/**
 * global::can-edit-wiki (deep-dive decision 06 §B2, §J2; batch 16 lane 16B,
 * policy kind `row-write-gate`): the write gate of wiki pages, on every
 * route of api/wiki-page but the reads and the delete, configured with the
 * route's `{ uid }` and, for the custom actions, its `intent`.
 *
 *   - admin_role and editor: the `moderator` class on every page. No
 *     bypass since batch 16: their payloads go through the allowlist's
 *     moderator rule like everyone's.
 *   - the row classes (@sinnlos/domain wiki-edit.ts classifyWikiEditor):
 *     the page's author, the head of its department, the lead of its team,
 *     on every row of the page and only while it sits in a space they can
 *     read; department heads and team leads create (`author`).
 *   - everyone else, and every refused row: false (403) on the generic
 *     create and update and on the lists, 404 on the custom page actions.
 *
 * The rules, the loader and the classifier live in utils/wiki-gate.ts; the
 * decision travels to the authoring controller on ctx.state.
 */
export default wikiPageGate();
