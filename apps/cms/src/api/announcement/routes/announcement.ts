import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::announcement.announcement", {
  config: {
    // Targeting (audience/department/team/audienceRoles) is enforced here,
    // not in the web queries — see policies/announcement-visibility.ts.
    find: { policies: ["global::announcement-visibility"] },
    findOne: { policies: ["global::announcement-visibility"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
