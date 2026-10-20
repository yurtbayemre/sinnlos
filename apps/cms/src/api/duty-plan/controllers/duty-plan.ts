import { factories } from "@strapi/strapi";

import { authoringActions } from "../../../utils/authoring-controller";

/**
 * Duty plans (v0.18): the v2 authoring controller (utils/authoring-controller.ts)
 * replaces the core create, update and delete and adds publish, unpublish,
 * discardDraft, authoringList and editable. find and findOne stay the
 * core's, behind published-only.
 */
export default factories.createCoreController("api::duty-plan.duty-plan", ({ strapi }) => ({
  ...authoringActions(strapi, "api::duty-plan.duty-plan"),
}));
