/**
 * The v2 authoring routes of polls (deep-dive decision 06 §B3, §B4; batch
 * 15 lane 15A; the HTTP contract is @sinnlos/domain authoring/http.ts):
 * the /manage list and the form read. A poll publishes at create and
 * closes through `closesAt`, so it has no publish, unpublish or
 * discard-draft route.
 *
 * The authoring controller (utils/authoring-controller.ts) serves them.
 * Each carries global::can-author with the route's `{ uid, intent }`:
 * the class and, on a document, the canonical draft and the row gate
 * (utils/write-gate.ts); no class answers 404 on the document actions
 * and 403 on the list. Granted through CUSTOM_ACTION_GRANTS
 * (bootstrap/permission-matrix.ts), never to guest or `authenticated`.
 *
 * The file name sorts before the core router file on purpose: @strapi/core
 * registers an API's route files in name order and the first matching
 * route wins, so `GET /polls/authoring` must come before the core
 * `GET /polls/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::poll.poll";

export default {
  routes: [
    {
      method: "GET",
      path: "/polls/authoring",
      handler: "api::poll.poll.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/polls/:id/editable",
      handler: "api::poll.poll.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
  ],
};
