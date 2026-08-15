import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::wiki-revision.wiki-revision", {
  config: {
    find: { policies: [{ name: "global::wiki-visibility", config: { level: "revision" } }] },
    findOne: { policies: [{ name: "global::wiki-visibility", config: { level: "revision" } }] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
