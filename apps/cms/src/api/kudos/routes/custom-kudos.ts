export default {
  routes: [
    {
      method: "GET",
      path: "/celebrations",
      handler: "api::kudos.kudos.celebrations",
      config: { policies: [] },
    },
  ],
};
