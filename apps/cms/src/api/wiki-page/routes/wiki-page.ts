import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::wiki-page.wiki-page", {
  config: {
    find: { policies: [{ name: "global::wiki-visibility", config: { level: "page" } }] },
    findOne: { policies: [{ name: "global::wiki-visibility", config: { level: "page" } }] },
    create: { policies: ["global::can-edit-wiki"] },
    update: { policies: ["global::can-edit-wiki"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
