import { factories } from "@strapi/strapi";

import { authoringActions } from "../../../utils/authoring-controller";

/**
 * Wiki spaces: the v2 authoring controller (utils/authoring-controller.ts;
 * deep-dive decision 06 §J1, §B3, batch 16 lane 16B) replaces the core
 * create, update and delete and adds authoringList and editable. Spaces
 * are always published. find and findOne stay the core's, behind their read
 * policy.
 */
export default factories.createCoreController("api::wiki-space.wiki-space", ({ strapi }) => ({
  ...authoringActions(strapi, "api::wiki-space.wiki-space"),
}));
