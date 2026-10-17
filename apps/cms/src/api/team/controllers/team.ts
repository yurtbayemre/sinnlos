import { factories } from "@strapi/strapi";

import { orgAuthoringActions } from "../../../utils/org-authoring";

const UID = "api::team.team";

export default factories.createCoreController(UID, ({ strapi }) => ({
  ...orgAuthoringActions(strapi, UID),
}));
