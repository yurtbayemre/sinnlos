/**
 * The v2 authoring routes of duty plans (v0.18; as for documents, deep-dive decision 06 §B3, §B4;
 * batch 15 lane 15A; the HTTP contract is @sinnlos/domain
 * authoring/http.ts): publish, unpublish and discard-draft, the /manage
 * list and the form read.
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
 * route wins, so `GET /duty-plans/authoring` must come before the core
 * `GET /duty-plans/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::duty-plan.duty-plan";

export default {
  routes: [
    {
      method: "GET",
      path: "/duty-plans/authoring",
      handler: "api::duty-plan.duty-plan.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/duty-plans/:id/editable",
      handler: "api::duty-plan.duty-plan.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/duty-plans/:id/publish",
      handler: "api::duty-plan.duty-plan.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/duty-plans/:id/unpublish",
      handler: "api::duty-plan.duty-plan.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/duty-plans/:id/discard-draft",
      handler: "api::duty-plan.duty-plan.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
