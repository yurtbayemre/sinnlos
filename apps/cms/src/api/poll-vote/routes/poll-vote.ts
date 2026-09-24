import { factories } from "@strapi/strapi";

/**
 * NO generic /api/poll-votes routes at all (FX01, decisions/02): the only
 * interface is the custom POST /polls/:id/vote and GET /polls/:id/results
 * (custom-poll-vote.ts). The core create/update/delete bypassed every
 * invariant of the vote handler (voter = caller, one vote per user,
 * closesAt, option bounds), and the core reads let a caller populate the
 * poll of their own old votes. `only: []` makes createCoreRouter pick zero
 * routes; the permission rows are revoked via REMOVED_CORE_ACTIONS in
 * src/index.ts.
 */
export default factories.createCoreRouter("api::poll-vote.poll-vote", {
  only: [],
});
