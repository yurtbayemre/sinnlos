import { factories } from "@strapi/strapi";

import {
  loadPollViewer,
  loadPublishedPoll,
  pollOptionCount,
  pollResultsBody,
  type PollCaller,
} from "../../../utils/poll-access";
import { canSeePoll, canVoteOnPoll, isInPollAudience } from "../../../utils/poll-audience";
import { countPollBallots, isOptionIndex } from "../../../utils/poll-ballots";
import { isPollClosed } from "../../../utils/poll-close";

/**
 * The only interface to poll votes (the generic /api/poll-votes routes do
 * not exist, routes/poll-vote.ts): POST /polls/:id/vote and
 * GET /polls/:id/results. `:id` addresses the poll by its documentId (DA01:
 * the address the web sends, stable across publishes) or, as the fallback
 * for older callers, by the numeric id of its PUBLISHED row
 * (utils/poll-access.ts loadPublishedPoll). Either way the handlers work
 * with the published row: the vote stores its id, the results count its
 * votes.
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
 *     read;
 *   - a vote stores an option INDEX, and the documentId address survives a
 *     republish, so the web also sends the option text its card showed
 *     (`option`): when the poll's options changed since (reordered or
 *     replaced in the admin panel), that text no longer sits at the index
 *     and the vote is refused with 400 "Poll options changed" instead of
 *     recording a different answer (the card then reloads). A body without
 *     a string `option` (a web from before this check) is not compared.
 * Results never name a voter. They include the caller's own vote even on
 * anonymous polls (FX20: the card needs it to show "you voted").
 *
 * One ballot per voter (utils/poll-ballots.ts): a vote cannot be changed, so
 * a voter's first accepted ballot (the row with the lowest id) is the one
 * the results count, whatever duplicates a parallel race stored. The vote
 * handler also deletes a voter's later rows right after its insert, so
 * stored duplicates converge to that ballot. The results count in ONE SQL
 * statement with a GROUP BY (countPollBallots, FX20): rows and voters from
 * one snapshot, so a duplicate a parallel cleanup deletes mid-read never
 * shows up as a ballot of a deleted account.
 */

/** The vote body the handler reads; anything else in it is ignored. */
interface VoteBody {
  optionIndex?: unknown;
  /** The option text the voter saw at `optionIndex` (optional, see above). */
  option?: unknown;
}

interface IdRow {
  id: number;
}

const pollOptions = (options: unknown): unknown[] => (Array.isArray(options) ? options : []);

export default factories.createCoreController("api::poll-vote.poll-vote", ({ strapi }) => ({
  async vote(ctx) {
    const user = ctx.state.user as PollCaller | null | undefined;
    if (!user) return ctx.unauthorized();

    const body: unknown = ctx.request.body;
    const fields: VoteBody = typeof body === "object" && body !== null ? (body as VoteBody) : {};
    const { optionIndex, option: shownOption } = fields;
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

    const options = pollOptions(poll.options);
    if (optionIndex >= options.length) return ctx.badRequest("Invalid optionIndex");
    // The card showed a different option at this index: the options were
    // reordered or replaced after it rendered. Refused before any write.
    if (typeof shownOption === "string" && options[optionIndex] !== shownOption) {
      return ctx.badRequest("Poll options changed");
    }

    // Closed iff now >= closesAt, the same rule as the web (utils/poll-close.ts).
    if (isPollClosed(poll.closesAt)) return ctx.badRequest("Poll is closed");

    // Check-then-insert without a DB unique constraint (voter is a link-table
    // relation, #16, DA04): truly parallel votes by one user can all pass
    // this check and insert. The cleanup below collapses them.
    const votes = strapi.db.query("api::poll-vote.poll-vote");
    const existing = await votes.findOne({
      where: { poll: poll.id, voter: user.id },
      select: ["id"],
    });
    if (existing) return ctx.badRequest("Already voted");

    // Null when this ballot is already gone: create() inserts the row,
    // commits its relation links, then reads the row back
    // (@strapi/database 5.55.1 entity-manager create), and a parallel vote
    // of the same voter can run the cleanup below in between and delete it.
    const vote = (await votes.create({
      data: { poll: poll.id, optionIndex, voter: user.id },
    })) as IdRow | null;

    // Keep the voter's first ballot for this poll (the lowest id, the one the
    // results count, utils/poll-ballots.ts) and delete the later ones. Every
    // vote checks AFTER its own insert, so the one that checks last sees
    // every row and leaves exactly one; the first ballot is never deleted
    // here, so one always stays. The same pattern as the reaction create.
    const mine = (await votes.findMany({
      where: { poll: poll.id, voter: user.id },
      select: ["id"],
      orderBy: { id: "asc" },
    })) as IdRow[];
    const [first, ...later] = mine;
    // One entity-manager delete per row, not deleteMany: the latter is a bare
    // query-builder delete in @strapi/database 5.55.1 and would leave the
    // poll and voter link rows behind.
    for (const row of later) await votes.delete({ where: { id: row.id } });
    // This request's ballot came second (or a parallel cleanup already
    // deleted it, see create above): it does not count, the answer a vote
    // gets that finds the first ballot already there.
    if (!vote || (first && first.id !== vote.id)) return ctx.badRequest("Already voted");
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

    // Counted in the database: ballots per option, one per voter, and the
    // caller's own option (FX20). No voter id leaves the statement; the
    // response carries counts and the caller's own vote only, whatever
    // `anonymous` says. The body is the one GET /api/poll-results lists
    // (utils/poll-access.ts pollResultsBody).
    const tally = await countPollBallots(strapi, poll.id, user.id, pollOptionCount(poll));
    return ctx.send(pollResultsBody(poll, tally, viewer));
  },
}));
