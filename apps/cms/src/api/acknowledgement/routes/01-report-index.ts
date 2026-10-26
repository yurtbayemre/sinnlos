/**
 * The admin's acknowledgement report index (v0.31, #173). POST, so the core
 * GET /acknowledgements/:id never sees it; the controller checks admin_role
 * again whatever the grants say.
 */
export default {
  routes: [
    {
      method: "POST",
      path: "/acknowledgements/report-index",
      handler: "api::acknowledgement.acknowledgement.reportIndex",
      config: { policies: [] },
    },
  ],
};
