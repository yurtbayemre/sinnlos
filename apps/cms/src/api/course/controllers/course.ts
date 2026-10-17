import { factories } from "@strapi/strapi";
import { authoringActions } from "../../../utils/authoring-controller";

export default factories.createCoreController("api::course.course", ({ strapi }) => ({
  ...authoringActions(strapi, "api::course.course"),
}));
