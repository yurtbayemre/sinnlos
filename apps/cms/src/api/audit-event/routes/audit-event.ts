export default {
  routes: [
    {
      method: "GET",
      path: "/audit-events",
      handler: "api::audit-event.audit-event.list",
      // The controller checks admin_role again, even if a grant drifts.
      config: { policies: [] },
    },
  ],
};
