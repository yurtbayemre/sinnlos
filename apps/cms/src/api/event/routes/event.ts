import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::event.event", {
  config: {
    // draft & publish without a visibility filter: pin reads to published
    // rows, or `?status=draft` hands out unpublished events (FX06, §5.24).
    find: { policies: ["global::published-only"] },
    findOne: { policies: ["global::published-only"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-admin-or-editor"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
