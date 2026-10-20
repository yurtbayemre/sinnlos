import { factories } from "@strapi/strapi";

import { authoringActions } from "../../../utils/authoring-controller";

/**
 * KPIs (v0.19): the v2 authoring controller (utils/authoring-controller.ts)
 * replaces the core create, update and delete and adds publish, unpublish,
 * discardDraft, authoringList and editable. find and findOne stay the
 * core's, behind published-only.
 */
export default factories.createCoreController("api::kpi.kpi", ({ strapi }) => ({
  ...authoringActions(strapi, "api::kpi.kpi"),
}));
