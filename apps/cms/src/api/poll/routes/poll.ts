import { factories } from "@strapi/strapi";

/**
 * create and update go through the v2 write gate (global::can-author with
 * the route's uid; deep-dive decision 06 §B2, batch 15 lane 15A): the
 * allowlist rule of the caller's class, then the authoring controller.
 * delete stays admin_role/editor (is-admin-or-editor) and needs If-Match.
 */
const UID = "api::poll.poll";

export default factories.createCoreRouter(UID, {
  config: {
    // Department targeting (decision 02): a targeted poll is readable only
    // by its departments' members (admin_role/editor bypass). The policy
    // also pins reads to published rows, so it REPLACES
    // global::published-only here (FX06) — do not stack both.
    find: { policies: ["global::poll-visibility"] },
    findOne: { policies: ["global::poll-visibility"] },
    create: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    update: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
