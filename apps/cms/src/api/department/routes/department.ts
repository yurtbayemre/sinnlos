import { factories } from "@strapi/strapi";

/**
 * Reads are pinned to published rows (FX06, §5.24). No populate guard here:
 * `pages` (inverse of wiki-page.department) is cut for non-admin/editor
 * callers on EVERY content-api route — populate, filters and sort — by the
 * global relation guard (FX05, registerRestrictedRelationGuard in
 * src/index.ts), because /api/users, wiki-spaces, events, ... reach
 * `department.pages` just as well as these routes do.
 */
export default factories.createCoreRouter("api::department.department", {
  config: {
    find: { policies: ["global::published-only"] },
    findOne: { policies: ["global::published-only"] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-department-head"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
