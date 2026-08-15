import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::quick-link.quick-link", {
  config: {
    find: { policies: ["global::quick-link-visibility"] },
    findOne: { policies: ["global::quick-link-visibility"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
