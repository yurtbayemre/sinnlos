import { factories } from "@strapi/strapi";

import { loadPollViewer, loadPublishedPoll, type PollCaller } from "../../../utils/poll-access";
import {
  canSeePoll,
  canVoteOnPoll,
  isInPollAudience,
  isPollTargeted,
} from "../../../utils/poll-audience";
import { isOptionIndex, tallyBallots, type BallotRow } from "../../../utils/poll-ballots";
import { isPollClosed } from "../../../utils/poll-close";

/**
 * The only interface to poll votes (the generic /api/poll-votes routes do
 * not exist, routes/poll-vote.ts): POST /polls/:id/vote and
 * GET /polls/:id/results, `:id` = the numeric id of the PUBLISHED poll row.
 *
 * Department targeting (decision 02) and guest access (owner decision
 * 2026-09-27), rules in utils/poll-audience.ts, are checked here, not by a
 * route policy:
 *   - a missing id, a malformed id, a draft row, a poll outside the
 *     caller's audience and, for a guest, a poll not visible to guests all
 *     answer the SAME 404 (no existence oracle);
 *   - admin_role/editor read every poll and its results, but voting takes
 *     audience membership (403 "Not in poll audience" for them outside it;
 *     nobody else can get that far);
 *   - a guest who sees a poll votes only when guests may vote on it (403
 *     "Guests cannot vote on this poll" otherwise; only a guest gets there);
 *   - the voter is always the caller: the body's `poll`/`voter` are never
 *     read.
 * Results never name a voter. They include the caller's own vote even on
 * anonymous polls (FX20: the card needs it to show "you voted").
 *
 * One ballot per voter (utils/poll-ballots.ts): a vote cannot be changed, so
 * a voter's first accepted ballot (the row with the lowest id) is the one
 * the results count, whatever duplicates a parallel race stored.
 */

interface OptionIndexRow {
  optionIndex?: unknown;
}

const pollOptions = (options: unknown): unknown[] => (Array.isArray(options) ? options : []);

export default factories.createCoreController("api::poll-vote.poll-vote", ({ strapi }) => ({
  async vote(ctx) {
    const user = ctx.state.user as PollCaller | null | undefined;
    if (!user) return ctx.unauthorized();

    const body: unknown = ctx.request.body;
    const optionIndex =
      typeof body === "object" && body !== null ? (body as OptionIndexRow).optionIndex : undefined;
    if (!isOptionIndex(optionIndex)) return ctx.badRequest("optionIndex required");

    const [poll, viewer] = await Promise.all([
      loadPublishedPoll(strapi, ctx.params.id),
      loadPollViewer(strapi, user),
    ]);
    if (!poll || !canSeePoll(poll, viewer)) return ctx.notFound();
    // Only admin_role/editor can see a poll outside its audience.
    if (!isInPollAudience(poll, viewer)) return ctx.forbidden("Not in poll audience");
    // Only a guest can see a poll it may not vote on (guestsCanVote off).
    if (!canVoteOnPoll(poll, viewer)) return ctx.forbidden("Guests cannot vote on this poll");

    if (optionIndex >= pollOptions(poll.options).length) return ctx.badRequest("Invalid optionIndex");

    // Closed iff now >= closesAt, the same rule as the web (utils/poll-close.ts).
    if (isPollClosed(poll.closesAt)) return ctx.badRequest("Poll is closed");

    // Check-then-insert without a DB unique constraint (voter is a link-table
    // relation): two truly parallel votes by one user can both land. Accepted
    // race, as for acks and RSVPs (#16).
    const votes = strapi.db.query("api::poll-vote.poll-vote");
    const existing = await votes.findOne({
      where: { poll: poll.id, voter: user.id },
      select: ["id"],
    });
    if (existing) return ctx.badRequest("Already voted");

    const vote = await votes.create({
      data: { poll: poll.id, optionIndex, voter: user.id },
    });
    return ctx.send({ data: vote });
  },

  async results(ctx) {
    const user = ctx.state.user as PollCaller | null | undefined;
    if (!user) return ctx.unauthorized();

    const [poll, viewer] = await Promise.all([
      loadPublishedPoll(strapi, ctx.params.id),
      loadPollViewer(strapi, user),
    ]);
    if (!poll || !canSeePoll(poll, viewer)) return ctx.notFound();

    // The voter's id only, to count one ballot per voter (tallyBallots) and
    // find the caller's own: it never leaves this handler. The response
    // carries counts and the caller's own vote only, whatever `anonymous`
    // says.
    // id must stay in the select: a relation filter makes @strapi/database
    // add DISTINCT (query-builder.js shouldUseDistinct), and without the
    // primary key identical votes collapse into one row.
    const rows = (await strapi.db.query("api::poll-vote.poll-vote").findMany({
      where: { poll: poll.id },
      select: ["id", "optionIndex"],
      populate: { voter: { select: ["id"] } },
    })) as BallotRow[];

    const options = pollOptions(poll.options);
    const { counts, total, myVoteIndex } = tallyBallots(rows, options.length, user.id);

    return ctx.send({
      poll: {
        id: poll.id,
        question: poll.question,
        options,
        closesAt: poll.closesAt,
        anonymous: poll.anonymous ?? false,
        // The stored guest-access flags as strict booleans (NULL = false);
        // guestsCanVote counts only together with visibleToGuests.
        visibleToGuests: poll.visibleToGuests,
        guestsCanVote: poll.guestsCanVote,
      },
      counts,
      total,
      myVoteIndex,
      canVote: canVoteOnPoll(poll, viewer),
      audience: {
        targeted: isPollTargeted(poll),
        departments: poll.departments
          .filter((department) => typeof department.documentId === "string")
          .map((department) => ({
            documentId: department.documentId as string,
            name: department.name ?? "",
          })),
      },
    });
  },
}));
