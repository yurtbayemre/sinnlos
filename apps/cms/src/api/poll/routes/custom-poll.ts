/**
 * The batched poll results (WD04): GET /api/poll-results?ids=<documentIds
 * or row ids>, the results of up to 50 polls for the caller in one request
 * (controllers/poll.ts `batchResults`). Granted via CUSTOM_ACTION_GRANTS
 * in src/bootstrap/permission-matrix.ts to every role, like the single
 * GET /api/polls/:id/results. No route policy: the controller decides
 * canSeePoll per poll (utils/poll-audience.ts) and leaves out every poll
 * the caller may not see.
 *
 * Its own path, not /polls/<word>: under /polls the core GET /polls/:id
 * route would compete for the request (routes.matrix.test.ts pins the
 * route order for such paths).
 */
export default {
  routes: [
    {
      method: "GET",
      path: "/poll-results",
      handler: "api::poll.poll.batchResults",
      config: { policies: [] },
    },
  ],
};
