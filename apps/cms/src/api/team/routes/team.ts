import { factories } from "@strapi/strapi";

/**
 * Reads are pinned to published rows (FX06). `pages` (inverse of
 * wiki-page.team) is cut by the global relation guard (FX05) — see the
 * department router.
 */
export default factories.createCoreRouter("api::team.team", {
  config: {
    find: { policies: ["global::published-only"] },
    findOne: { policies: ["global::published-only"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-team-member-or-lead"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
