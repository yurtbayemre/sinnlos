/**
 * The only poll-vote interface (the core router is `only: []`). No route
 * policy on purpose: the published-row pin, department targeting
 * (decision 02) and the vote rules are checked in the controller
 * (controllers/poll-vote.ts), which needs the poll row for all of them.
 */
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
