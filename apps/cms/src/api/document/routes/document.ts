import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::document.document", {
  config: {
    find: { policies: ["global::document-visibility"] },
    findOne: { policies: ["global::document-visibility"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
