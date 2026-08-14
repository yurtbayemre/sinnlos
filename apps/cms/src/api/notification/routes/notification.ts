import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::notification.notification", {
  config: {
    find: { policies: ["global::notification-visibility"] },
    findOne: { policies: ["global::notification-visibility"] },
    create: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-notification-recipient"] },
  },
});
