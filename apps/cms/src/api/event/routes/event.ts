import { factories } from "@strapi/strapi";

/**
 * create and update go through the v2 write gate (global::can-author with
 * the route's uid; deep-dive decision 06 §B2, batch 15 lane 15A): the
 * allowlist rule of the caller's class, then the authoring controller.
 * delete stays admin_role/editor (is-admin-or-editor) and needs If-Match.
 */
const UID = "api::event.event";

export default factories.createCoreRouter(UID, {
  config: {
    // draft & publish without a visibility filter: pin reads to published
    // rows, or `?status=draft` hands out unpublished events (FX06, §5.24).
    find: { policies: ["global::published-only"] },
    findOne: { policies: ["global::published-only"] },
    create: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    update: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
