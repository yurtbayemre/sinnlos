import { factories } from "@strapi/strapi";

/**
 * Notifications are written by the CMS lifecycles only (db.query), so the
 * core create/update routes are not exposed (FX01): the core PUT had no
 * policy and let an editor rewrite any user's notification. Reads are
 * recipient-scoped; mark-read lives in custom-notification.ts.
 */
export default factories.createCoreRouter("api::notification.notification", {
  only: ["find", "findOne", "delete"],
  config: {
    find: { policies: ["global::notification-visibility"] },
    findOne: { policies: ["global::notification-visibility"] },
    delete: { policies: ["global::is-notification-recipient"] },
  },
});
