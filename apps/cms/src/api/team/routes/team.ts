import { factories } from "@strapi/strapi";

/**
 * Reads are pinned to `status=published` (FX06); team is single-row since
 * decision 05, so the pin only narrows populated draft & publish relations
 * (see published-only.ts). `pages` (inverse of
 * wiki-page.team) is cut by the global relation guard (FX05) — see the
 * department router.
 */
export default factories.createCoreRouter("api::team.team", {
  config: {
    find: { policies: ["global::published-only"] },
    findOne: { policies: ["global::published-only"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::can-edit-team"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
