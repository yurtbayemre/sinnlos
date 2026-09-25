import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::poll.poll", {
  config: {
    // Pin reads to published rows (FX06, §5.24). The planned
    // global::poll-visibility (decisions/02-poll-targeting) pins the status
    // itself and REPLACES this policy here — do not stack both.
    find: { policies: ["global::published-only"] },
    findOne: { policies: ["global::published-only"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
