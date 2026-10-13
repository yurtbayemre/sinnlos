import { factories } from "@strapi/strapi";

/**
 * Reads stay behind wiki-visibility. create and update go through the v2
 * write gate (global::can-author with the route's uid; deep-dive decision
 * 06 §J1, §B3, batch 16 lane 16B): the moderator rule, always published.
 * delete stays admin_role/editor (is-admin-or-editor), needs If-Match and
 * is refused while the space has pages (the wiki checks, `spaceNotEmpty`).
 * The list and the form read are in 00-authoring.ts.
 */
const UID = "api::wiki-space.wiki-space";

export default factories.createCoreRouter(UID, {
  config: {
    find: { policies: [{ name: "global::wiki-visibility", config: { level: "space" } }] },
    findOne: { policies: [{ name: "global::wiki-visibility", config: { level: "space" } }] },
    create: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    update: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
