/** Fixed learner responses: the controller checks the published lesson and parent. */
export default {
  routes: [
    {
      method: "GET",
      path: "/lessons/:id/player",
      handler: "api::lesson.lesson.player",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/lessons/:id/check",
      handler: "api::lesson.lesson.check",
      config: { policies: [] },
    },
  ],
};
