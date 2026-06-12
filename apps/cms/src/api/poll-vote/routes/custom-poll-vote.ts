export default {
  routes: [
    {
      method: "POST",
      path: "/polls/:id/vote",
      handler: "api::poll-vote.poll-vote.vote",
      config: { policies: [] },
    },
    {
      method: "GET",
      path: "/polls/:id/results",
      handler: "api::poll-vote.poll-vote.results",
      config: { policies: [] },
    },
  ],
};
