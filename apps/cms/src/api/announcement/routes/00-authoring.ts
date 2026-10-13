/**
 * The v2 authoring routes of announcement (deep-dive decision 06 §B3, §B4;
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
 * route wins, so `GET /announcements/authoring` must come before the core
 * `GET /announcements/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::announcement.announcement";

export default {
  routes: [
    {
      method: "GET",
      path: "/announcements/authoring",
      handler: "api::announcement.announcement.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/announcements/:id/editable",
      handler: "api::announcement.announcement.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/announcements/:id/publish",
      handler: "api::announcement.announcement.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/announcements/:id/unpublish",
      handler: "api::announcement.announcement.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/announcements/:id/discard-draft",
      handler: "api::announcement.announcement.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
