/**
 * The v2 authoring routes of event (deep-dive decision 06 §B3, §B4;
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
 * route wins, so `GET /events/authoring` must come before the core
 * `GET /events/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::event.event";

export default {
  routes: [
    {
      method: "GET",
      path: "/events/authoring",
      handler: "api::event.event.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/events/:id/editable",
      handler: "api::event.event.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/events/:id/publish",
      handler: "api::event.event.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/events/:id/unpublish",
      handler: "api::event.event.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/events/:id/discard-draft",
      handler: "api::event.event.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
