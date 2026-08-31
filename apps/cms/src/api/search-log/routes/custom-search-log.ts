export default {
  routes: [
    {
      // Aggregated search analytics for /manage/analytics. Gated twice:
      // the users-permissions grant (CUSTOM_ACTION_GRANTS → admin_role
      // only) and the policy below.
      method: "GET",
      path: "/search-logs/summary",
      handler: "api::search-log.search-log.summary",
      config: { policies: ["global::is-admin-or-editor"] },
    },
  ],
};
