import { factories } from "@strapi/strapi";

/** Read-only, like course — see the course router for the rationale. */
export default factories.createCoreRouter("api::lesson.lesson", {
  only: ["find", "findOne"],
  config: {
    find: { policies: [{ name: "global::training-visibility", config: { level: "lesson" } }] },
    findOne: { policies: [{ name: "global::training-visibility", config: { level: "lesson" } }] },
  },
});
