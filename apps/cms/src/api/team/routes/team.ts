import { factories } from "@strapi/strapi";

/**
 * Reads drop every populate path into wiki pages for non-admin/editor
 * callers (FX05) — see the department router: `pages` is the inverse of
 * wiki-page.team, and `department.pages` is one hop away.
 */
const STRIP_WIKI_POPULATE = {
  name: "global::strip-restricted-populate",
  config: { uid: "api::team.team", targets: ["api::wiki-page.wiki-page"] },
};

export default factories.createCoreRouter("api::team.team", {
  config: {
    find: { policies: [STRIP_WIKI_POPULATE] },
    findOne: { policies: [STRIP_WIKI_POPULATE] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-team-member-or-lead"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
