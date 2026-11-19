import { factories } from "@strapi/strapi";

import { authoringActions } from "../../../utils/authoring-controller";

/**
 * Processes (v1.1): the v2 authoring controller (utils/authoring-controller.ts)
 * replaces the core create, update and delete and adds publish, unpublish,
 * discardDraft, authoringList and editable. find and findOne stay the
 * core's, behind published-only.
 */
export default factories.createCoreController("api::process.process", ({ strapi }) => ({
  ...authoringActions(strapi, "api::process.process"),
}));
