import { factories } from "@strapi/strapi";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default factories.createCoreController("api::poll.poll", ({ strapi }) => ({
  /**
   * POST /api/polls (content API; the route policy admits admin_role and
   * editor). The author is server-authoritative (§5.21, FX20): it is always
   * the caller, whatever the payload says. The web's createPoll sends no
   * author, so web-created polls used to have none. A body without a `data`
   * object goes to the core create unchanged, which answers its own 400.
   * The admin panel writes through the Content Manager, not this
   * controller: an editor there still picks the author by hand.
   */
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body: unknown = ctx.request.body;
    if (isRecord(body) && isRecord(body.data)) {
      ctx.request.body = { ...body, data: { ...body.data, author: user.id } };
    }
    return super.create(ctx);
  },

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
