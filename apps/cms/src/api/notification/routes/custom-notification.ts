export default {
  routes: [
    {
      method: "POST",
      path: "/notifications/mark-read",
      handler: "api::notification.notification.markRead",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/notifications/mark-all-read",
      handler: "api::notification.notification.markAllRead",
      config: { policies: [] },
    },
    {
      // v0.28: the platform-wide unread total for /manage/analytics
      // (admin_role grant, re-checked in the controller). Before the core
      // GET /notifications/:id, so the path is no id.
      method: "GET",
      path: "/notifications/unread-count",
      handler: "api::notification.notification.unreadCount",
      config: { policies: [] },
    },
  ],
};
