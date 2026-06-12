import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::notification.notification", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: [] },
  },
});
