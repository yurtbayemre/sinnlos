import { factories } from "@strapi/strapi";

/**
 * No update route (FX01): the web never edits kudos (moderation = the
 * admin/editor delete), and the core PUT ran without policy or override.
 */
export default factories.createCoreRouter("api::kudos.kudos", {
  only: ["find", "findOne", "create", "delete"],
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: [] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
