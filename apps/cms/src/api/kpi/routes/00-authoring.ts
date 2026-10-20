/**
 * The v2 authoring routes of KPIs (v0.19; as for duty plans and documents, deep-dive decision 06 §B3, §B4;
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
 * route wins, so `GET /kpis/authoring` must come before the core
 * `GET /kpis/:id` (routes.matrix.test.ts pins the order).
 */
const UID = "api::kpi.kpi";

export default {
  routes: [
    {
      method: "GET",
      path: "/kpis/authoring",
      handler: "api::kpi.kpi.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/kpis/:id/editable",
      handler: "api::kpi.kpi.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/kpis/:id/publish",
      handler: "api::kpi.kpi.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/kpis/:id/unpublish",
      handler: "api::kpi.kpi.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/kpis/:id/discard-draft",
      handler: "api::kpi.kpi.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
