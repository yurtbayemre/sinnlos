import { factories } from "@strapi/strapi";

import { authoringActions } from "../../../utils/authoring-controller";

/**
 * Announcements: the v2 authoring controller (utils/authoring-controller.ts;
 * deep-dive decision 06 §B3, batch 15 lane 15A) replaces the core create,
 * update and delete and adds publish, unpublish, discardDraft, authoringList and editable.
 * find and findOne stay the core's, behind their read policy.
 */
export default factories.createCoreController("api::announcement.announcement", ({ strapi }) => ({
  ...authoringActions(strapi, "api::announcement.announcement"),
}));
