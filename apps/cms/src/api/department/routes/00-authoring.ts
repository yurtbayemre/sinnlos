export default {
  routes: [
    {
      method: "GET",
      path: "/departments/:id/editable",
      handler: "api::department.department.editable",
      config: {
        policies: [{ name: "global::can-edit-department", config: { intent: "editable" } }],
      },
    },
  ],
};
