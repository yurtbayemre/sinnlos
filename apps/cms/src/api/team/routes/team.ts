import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::team.team", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-team-member-or-lead"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
