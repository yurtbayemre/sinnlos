export default {
  routes: [
    {
      method: "GET",
      path: "/me",
      handler: "api::profile.profile.me",
      config: { policies: [] },
    },
    {
      method: "PUT",
      path: "/me",
      handler: "api::profile.profile.updateMe",
      config: { policies: [] },
    },
  ],
};
