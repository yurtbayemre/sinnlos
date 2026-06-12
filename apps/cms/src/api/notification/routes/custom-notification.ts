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
  ],
};
