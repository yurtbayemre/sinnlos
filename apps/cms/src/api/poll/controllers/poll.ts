import { factories } from "@strapi/strapi";

import { authoringActions } from "../../../utils/authoring-controller";
import {
  loadPollViewer,
  loadPublishedPolls,
  parsePollRefs,
  pollOptionCount,
  pollResultsBody,
  type PollCaller,
} from "../../../utils/poll-access";
import { canSeePoll } from "../../../utils/poll-audience";
import { countPollBallotsMany } from "../../../utils/poll-ballots";

/**
 * Polls: the v2 authoring controller (utils/authoring-controller.ts;
 * deep-dive decision 06 §B3, batch 15 lane 15A) replaces the core create,
 * update and delete and adds authoringList and editable (a poll publishes at create and closes
 * through closesAt: no publish, unpublish or discard). The author is the
 * caller, set by the allowlist on create (callerFields): a payload naming
 * one is refused. batchResults below is the poll's own.
 * find and findOne stay the core's, behind their read policy.
 */
export default factories.createCoreController("api::poll.poll", ({ strapi }) => ({
  ...authoringActions(strapi, "api::poll.poll"),

  /**
   * GET /api/poll-results?ids=<documentIds or row ids> (WD04): the results
   * of up to 50 polls in one request, each exactly the body of
   * GET /api/polls/:id/results for this caller (utils/poll-access.ts
   * pollResultsBody), in the order asked. Not under /polls/:id, where the
   * core findOne would take the request (routes/custom-poll.ts).
   *
   * Every poll is decided on its own, like the single read (decision 02,
   * guest access 2026-09-27): only PUBLISHED rows are loaded, and canSeePoll
   * decides per poll and caller. A missing id, a draft, a poll outside the
   * caller's audience and, for a guest, a poll not visible to guests are
   * all simply absent from `data`, identically (no existence oracle). The
   * counts come from ONE statement for all visible polls
   * (utils/poll-ballots.ts countPollBallotsMany: first ballot per voter).
   * Granted to every role (CUSTOM_ACTION_GRANTS), like the single results;
   * canSeePoll is the gate. A malformed id list is a 400.
   */
  async batchResults(ctx) {
    const user = ctx.state.user as PollCaller | null | undefined;
    if (!user) return ctx.unauthorized();

    const parsed = parsePollRefs(ctx.query?.ids);
    if ("error" in parsed) return ctx.badRequest(parsed.error);

    const [polls, viewer] = await Promise.all([
      loadPublishedPolls(strapi, parsed.refs),
      loadPollViewer(strapi, user),
    ]);
    const visible = polls.filter((poll) => canSeePoll(poll, viewer));
    const tallies = await countPollBallotsMany(
      strapi,
      visible.map((poll) => ({ id: poll.id, optionCount: pollOptionCount(poll) })),
      user.id,
    );
    return ctx.send({
      data: visible.map((poll) => {
        const tally = tallies.get(poll.id) ?? {
          counts: Array.from({ length: pollOptionCount(poll) }, () => 0),
          total: 0,
          myVoteIndex: null,
        };
        return pollResultsBody(poll, tally, viewer);
      }),
    });
  },
}));
