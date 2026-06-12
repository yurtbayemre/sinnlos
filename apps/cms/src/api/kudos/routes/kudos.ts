import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::kudos.kudos", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: [] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
