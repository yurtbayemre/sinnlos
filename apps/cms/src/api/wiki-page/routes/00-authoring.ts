/**
 * The wiki-page actions of v2 authoring (deep-dive decision 06 §J2; batch
 * 16 lane 16B; the HTTP contract is @sinnlos/domain authoring/wiki.ts):
 * drafts, publish, discard, unpublish, the moderators' list, the form read,
 * the history and restore.
 *
 * utils/authoring-controller.ts and utils/wiki-authoring.ts serve them.
 * Each carries global::can-edit-wiki (utils/wiki-gate.ts) with the route's
 * `{ uid, intent }`: the class (moderator, or the page's author, the head
 * of its department, the lead of its team) and, on a page, the canonical
 * draft and the row gate; no class answers 404 on a page action and 403 on
 * the lists. Granted through CUSTOM_ACTION_GRANTS (bootstrap/
 * permission-matrix.ts): createDraft to the creators, unpublish and
 * authoringList to the moderators, the rest to every wiki-page updater.
 *
 * The file name sorts before the core router file on purpose: @strapi/core
 * registers an API's route files in name order and the first matching route
 * wins, so `GET /wiki-pages/authoring` must come before the core
 * `GET /wiki-pages/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::wiki-page.wiki-page";

const gate = (intent: string) => ({
  policies: [{ name: "global::can-edit-wiki", config: { uid: UID, intent } }],
});

export default {
  routes: [
    {
      method: "GET",
      path: "/wiki-pages/authoring",
      handler: `${UID}.authoringList`,
      config: gate("authoringList"),
    },
    {
      method: "POST",
      path: "/wiki-pages/drafts",
      handler: `${UID}.createDraft`,
      config: gate("createDraft"),
    },
    {
      method: "GET",
      path: "/wiki-pages/drafts/mine",
      handler: `${UID}.myDrafts`,
      config: gate("myDrafts"),
    },
    {
      method: "GET",
      path: "/wiki-pages/:id/editable",
      handler: `${UID}.editable`,
      config: gate("editable"),
    },
    {
      method: "PUT",
      path: "/wiki-pages/:id/draft",
      handler: `${UID}.saveDraft`,
      config: gate("saveDraft"),
    },
    {
      method: "POST",
      path: "/wiki-pages/:id/publish",
      handler: `${UID}.publish`,
      config: gate("publish"),
    },
    {
      method: "POST",
      path: "/wiki-pages/:id/discard-draft",
      handler: `${UID}.discardDraft`,
      config: gate("discardDraft"),
    },
    {
      method: "POST",
      path: "/wiki-pages/:id/unpublish",
      handler: `${UID}.unpublish`,
      config: gate("unpublish"),
    },
    {
      method: "GET",
      path: "/wiki-pages/:id/revisions",
      handler: `${UID}.revisions`,
      config: gate("revisions"),
    },
    {
      method: "GET",
      path: "/wiki-pages/:id/revisions/:revisionId",
      handler: `${UID}.revision`,
      config: gate("revision"),
    },
    {
      method: "POST",
      path: "/wiki-pages/:id/restore",
      handler: `${UID}.restore`,
      config: gate("restore"),
    },
  ],
};
