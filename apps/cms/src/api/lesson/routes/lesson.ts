import { factories } from "@strapi/strapi";

/** Training is authored through the shared gate; deletion stays in the panel. */
export default factories.createCoreRouter("api::lesson.lesson", {
  only: ["find", "findOne", "create", "update"],
  config: {
    find: { policies: [{ name: "global::training-visibility", config: { level: "lesson" } }] },
    findOne: { policies: [{ name: "global::training-visibility", config: { level: "lesson" } }] },
    create: {
      policies: [
        { name: "global::can-author", config: { uid: "api::lesson.lesson", intent: "create" } },
      ],
    },
    update: {
      policies: [
        { name: "global::can-author", config: { uid: "api::lesson.lesson", intent: "update" } },
      ],
    },
  },
});
