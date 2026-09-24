import { factories } from "@strapi/strapi";

/**
 * Reads drop every populate path into wiki pages for non-admin/editor
 * callers (FX05): `pages` is the inverse of wiki-page.department, and the
 * department routes carry no wiki-visibility filter — `populate[pages]`
 * (or `*`, `teams.pages`, ...) returned pages of hidden spaces.
 */
const STRIP_WIKI_POPULATE = {
  name: "global::strip-restricted-populate",
  config: { uid: "api::department.department", targets: ["api::wiki-page.wiki-page"] },
};

export default factories.createCoreRouter("api::department.department", {
  config: {
    find: { policies: [STRIP_WIKI_POPULATE] },
    findOne: { policies: [STRIP_WIKI_POPULATE] },
    create: { policies: ["global::is-admin-or-editor"] },
    update: { policies: ["global::is-department-head"] },
    delete: { policies: ["global::is-admin-or-editor"] },
  },
});
