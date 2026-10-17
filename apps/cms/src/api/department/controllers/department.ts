import { factories } from "@strapi/strapi";

import { orgAuthoringActions } from "../../../utils/org-authoring";

const UID = "api::department.department";

export default factories.createCoreController(UID, ({ strapi }) => ({
  ...orgAuthoringActions(strapi, UID),
}));
