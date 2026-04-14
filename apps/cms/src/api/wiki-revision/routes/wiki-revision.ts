import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::wiki-revision.wiki-revision", {
  config: {
    find: { policies: ["global::wiki-visibility"] },
    findOne: { policies: ["global::wiki-visibility"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
