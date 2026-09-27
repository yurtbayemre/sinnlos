import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::poll.poll", {
  config: {
    // Department targeting (decision 02): a targeted poll is readable only
    // by its departments' members (admin_role/editor bypass). The policy
    // also pins reads to published rows, so it REPLACES
    // global::published-only here (FX06) — do not stack both.
    find: { policies: ["global::poll-visibility"] },
    findOne: { policies: ["global::poll-visibility"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
