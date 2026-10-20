/**
 * The named training report (v0.20). Registered before the core :id route
 * so /report is not treated as an id. The controller checks the role and
 * the caller's department again, even if a grant drifts.
 */
export default {
  routes: [
    {
      method: "GET",
      path: "/courses/report",
      handler: "api::course.course.report",
      config: { policies: [] },
    },
    {
      method: "GET",
      path: "/courses/:id/report",
      handler: "api::course.course.reportCourse",
      config: { policies: [] },
    },
  ],
};
