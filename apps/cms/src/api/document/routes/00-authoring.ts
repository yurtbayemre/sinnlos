/**
 * The v2 authoring routes of document (deep-dive decision 06 §B3, §B4;
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
 * route wins, so `GET /documents/authoring` must come before the core
 * `GET /documents/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::document.document";

export default {
  routes: [
    {
      method: "GET",
      path: "/documents/authoring",
      handler: "api::document.document.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/documents/:id/editable",
      handler: "api::document.document.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/documents/:id/publish",
      handler: "api::document.document.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/documents/:id/unpublish",
      handler: "api::document.document.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/documents/:id/discard-draft",
      handler: "api::document.document.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
