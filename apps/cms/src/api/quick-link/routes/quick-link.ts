import { factories } from "@strapi/strapi";

/**
 * create and update go through the v2 write gate (global::can-author with
 * the route's uid; deep-dive decision 06 §B2, batch 15 lane 15A): the
 * allowlist rule of the caller's class, then the authoring controller.
 * delete stays admin_role/editor (is-admin-or-editor) and needs If-Match.
 */
const UID = "api::quick-link.quick-link";

export default factories.createCoreRouter(UID, {
  config: {
    find: { policies: ["global::quick-link-visibility"] },
    findOne: { policies: ["global::quick-link-visibility"] },
    create: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    update: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
