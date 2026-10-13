/**
 * The v2 authoring routes of quick-link (deep-dive decision 06 §B3, §B4;
 * batch 15 lane 15A; the HTTP contract is @sinnlos/domain authoring/
 * http.ts):
 * publish, unpublish and discard-draft, plus the /manage list and the
 * form read, served by the authoring controller
 * (utils/authoring-controller.ts). Each carries global::can-author with the
 * route's `{ uid, intent }`: the class and, on a document, the canonical
 * draft and the row gate (utils/write-gate.ts); no class answers 404 on
 * the document actions and 403 on the list. Granted through
 * CUSTOM_ACTION_GRANTS (bootstrap/permission-matrix.ts), never to guest or
 * `authenticated`.
 *
 * The file name sorts before the core router file on purpose: @strapi/core
 * registers an API's route files in name order and the first matching
 * route wins, so `GET /quick-links/authoring` must come before the core
 * `GET /quick-links/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::quick-link.quick-link";

export default {
  routes: [
    {
      method: "GET",
      path: "/quick-links/authoring",
      handler: "api::quick-link.quick-link.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/quick-links/:id/editable",
      handler: "api::quick-link.quick-link.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/quick-links/:id/publish",
      handler: "api::quick-link.quick-link.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/quick-links/:id/unpublish",
      handler: "api::quick-link.quick-link.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/quick-links/:id/discard-draft",
      handler: "api::quick-link.quick-link.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
