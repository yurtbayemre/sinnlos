import { factories } from "@strapi/strapi";

/**
 * Read-only content-api surface (admin-authoring variant, issue #29):
 * create/update/delete routes are not exposed at all — course
 * maintenance happens exclusively in the Strapi admin panel
 * (quick-links pattern, but stricter: not even granted routes exist).
 */
export default factories.createCoreRouter("api::course.course", {
  only: ["find", "findOne"],
  config: {
    find: { policies: [{ name: "global::training-visibility", config: { level: "course" } }] },
    findOne: { policies: [{ name: "global::training-visibility", config: { level: "course" } }] },
  },
});
