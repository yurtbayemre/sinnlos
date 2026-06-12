export default {
  routes: [
    {
      method: "GET",
      path: "/events/:id/ics",
      handler: "api::event.event.ics",
      config: {
        policies: [],
      },
    },
  ],
};
