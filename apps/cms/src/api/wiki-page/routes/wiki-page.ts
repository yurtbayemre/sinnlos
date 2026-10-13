import { factories } from "@strapi/strapi";

/**
 * Reads stay behind wiki-visibility. create and update go through the
 * rebuilt row gate (global::can-edit-wiki with the route's uid; deep-dive
 * decision 06 §J2, batch 16 lane 16B): the allowlist rule of the caller's
 * class, then the authoring controller (a fixed answer, `If-Match` on the
 * update). delete stays admin_role/editor (is-admin-or-editor) and needs
 * If-Match. The draft and history actions are in 00-authoring.ts.
 */
const UID = "api::wiki-page.wiki-page";

export default factories.createCoreRouter(UID, {
  config: {
    find: { policies: [{ name: "global::wiki-visibility", config: { level: "page" } }] },
    findOne: { policies: [{ name: "global::wiki-visibility", config: { level: "page" } }] },
    create: { policies: [{ name: "global::can-edit-wiki", config: { uid: UID } }] },
    update: { policies: [{ name: "global::can-edit-wiki", config: { uid: UID } }] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
