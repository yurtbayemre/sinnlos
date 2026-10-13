/**
 * The v2 authoring routes of wiki spaces (deep-dive decision 06 §J1, §B3,
 * §B4; batch 16 lane 16B; the HTTP contract is @sinnlos/domain
 * authoring/wiki.ts): the /manage list and the form read. A space is
 * published at every save, so it has no publish, unpublish or discard-draft
 * route.
 *
 * The authoring controller (utils/authoring-controller.ts) serves them.
 * Each carries global::can-author with the route's `{ uid, intent }`: the
 * moderator class only. Granted through CUSTOM_ACTION_GRANTS
 * (bootstrap/permission-matrix.ts) to admin_role and editor.
 *
 * The file name sorts before the core router file on purpose: @strapi/core
 * registers an API's route files in name order and the first matching route
 * wins, so `GET /wiki-spaces/authoring` must come before the core
 * `GET /wiki-spaces/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::wiki-space.wiki-space";

export default {
  routes: [
    {
      method: "GET",
      path: "/wiki-spaces/authoring",
      handler: "api::wiki-space.wiki-space.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/wiki-spaces/:id/editable",
      handler: "api::wiki-space.wiki-space.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
  ],
};
