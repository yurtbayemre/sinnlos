import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::poll.poll", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
