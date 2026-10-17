export default {
  routes: [
    {
      method: "GET",
      path: "/teams/:id/editable",
      handler: "api::team.team.editable",
      config: {
        policies: [{ name: "global::can-edit-team", config: { intent: "editable" } }],
      },
    },
  ],
};
