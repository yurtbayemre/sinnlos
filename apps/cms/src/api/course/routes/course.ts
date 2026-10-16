import { factories } from "@strapi/strapi";

/** Training is authored through the shared gate; deletion stays in the panel. */
export default factories.createCoreRouter("api::course.course", {
  only: ["find", "findOne", "create", "update"],
  config: {
    find: { policies: [{ name: "global::training-visibility", config: { level: "course" } }] },
    findOne: { policies: [{ name: "global::training-visibility", config: { level: "course" } }] },
    create: {
      policies: [
        { name: "global::can-author", config: { uid: "api::course.course", intent: "create" } },
      ],
    },
    update: {
      policies: [
        { name: "global::can-author", config: { uid: "api::course.course", intent: "update" } },
      ],
    },
  },
});
