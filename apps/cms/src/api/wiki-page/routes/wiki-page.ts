import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::wiki-page.wiki-page", {
  config: {
    find: { policies: ["global::wiki-visibility"] },
    findOne: { policies: ["global::wiki-visibility"] },
    create: { policies: ["global::can-edit-wiki"] },
    update: { policies: ["global::can-edit-wiki"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
