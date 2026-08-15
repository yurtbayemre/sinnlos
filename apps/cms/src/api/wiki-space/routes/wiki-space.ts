import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::wiki-space.wiki-space", {
  config: {
    find: { policies: [{ name: "global::wiki-visibility", config: { level: "space" } }] },
    findOne: { policies: [{ name: "global::wiki-visibility", config: { level: "space" } }] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
