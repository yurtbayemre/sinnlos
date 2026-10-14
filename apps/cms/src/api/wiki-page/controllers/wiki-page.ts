import { factories } from "@strapi/strapi";

import { authoringActions } from "../../../utils/authoring-controller";
import { wikiPageActions } from "../../../utils/wiki-authoring";

/**
 * Wiki pages: the v2 authoring controller (utils/authoring-controller.ts:
 * create, update, publish, unpublish, discardDraft, delete, authoringList,
 * editable) and the wiki's draft and history actions (utils/wiki-
 * authoring.ts: createDraft, saveDraft, myDrafts, revisions, revision,
 * restore); deep-dive decision 06 §J2, batch 16 lane 16B. Every write runs
 * inside wikiEditContext, so the history records its editor. find and
 * findOne stay the core's, behind wiki-visibility.
 */
export default factories.createCoreController("api::wiki-page.wiki-page", ({ strapi }) => ({
  ...authoringActions(strapi, "api::wiki-page.wiki-page"),
  ...wikiPageActions(strapi),
}));
