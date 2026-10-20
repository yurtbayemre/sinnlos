import { factories } from "@strapi/strapi";

/**
 * Duty plans (v0.18). Reads are pinned to published rows (published-only;
 * every staff role reads, guests hold no grant). create and update go
 * through the v2 write gate (global::can-author with the route's uid): the
 * allowlist rule of the caller's class, then the authoring controller.
 * delete stays admin_role/editor (is-admin-or-editor) and needs If-Match.
 */
const UID = "api::duty-plan.duty-plan";

export default factories.createCoreRouter(UID, {
  config: {
    find: { policies: ["global::published-only"] },
    findOne: { policies: ["global::published-only"] },
    create: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    update: { policies: [{ name: "global::can-author", config: { uid: UID } }] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
