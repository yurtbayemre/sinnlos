import { factories } from "@strapi/strapi";

import { lockDocument, type DocumentLockHost } from "../../../utils/document-lock";
import {
  POLL_UID,
  loadPollViewer,
  loadPublishedPoll,
  pollOptionCount,
  pollResultsBody,
  type PollCaller,
  type PublishedPoll,
} from "../../../utils/poll-access";
import {
  canSeePoll,
  canVoteOnPoll,
  isInPollAudience,
  type PollViewer,
} from "../../../utils/poll-audience";
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
 * UNDER THE POLL'S LOCK (deep-dive decision 06 §G2, batch 15 plan item 8).
 * A vote freezes the poll's options and anonymity (the poll guard,
 * utils/poll-audience-guard.ts, refuses changing them once a vote exists).
 * So the vote runs its reads, checks and insert in ONE transaction that
 * takes the poll's document lock (utils/document-lock.ts lockDocument, the
 * version row FOR UPDATE) first: a vote and an options change or a publish
 * of a changed draft sent at the same moment serialise on that row, and one
 * of them is refused (the change with frozenAfterVotes, or the vote with
 * "Poll options changed" / its index check on the new options). The lock is
 * taken only for a poll the caller can see (a first read outside it), so a
 * crafted id never creates a version row; inside it the published poll is
 * read again and every check runs on that read.
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

type VoteOutcome =
  | { kind: "notFound" }
  | { kind: "forbidden"; message: string }
  | { kind: "badRequest"; message: string }
  | { kind: "voted"; vote: IdRow };

export default factories.createCoreController("api::poll-vote.poll-vote", ({ strapi }) => {
  /**
   * The checks and the insert of one vote, inside the poll's lock. `poll`
   * is the published row read under the lock (null: gone since the first
   * read, a 404 like any missing poll).
   */
  const castVote = async (
    poll: PublishedPoll | null,
    viewer: PollViewer,
    voterId: number,
    optionIndex: number,
    shownOption: unknown,
  ): Promise<VoteOutcome> => {
    if (!poll || !canSeePoll(poll, viewer)) return { kind: "notFound" };
    // Only admin_role/editor can see a poll outside its audience.
    if (!isInPollAudience(poll, viewer))
      return { kind: "forbidden", message: "Not in poll audience" };
    // Only a guest can see a poll it may not vote on (guestsCanVote off).
    if (!canVoteOnPoll(poll, viewer)) {
      return { kind: "forbidden", message: "Guests cannot vote on this poll" };
    }

    const options = pollOptions(poll.options);
    if (optionIndex >= options.length)
      return { kind: "badRequest", message: "Invalid optionIndex" };
    // The card showed a different option at this index: the options were
    // reordered or replaced after it rendered. Refused before any write.
    if (typeof shownOption === "string" && options[optionIndex] !== shownOption) {
      return { kind: "badRequest", message: "Poll options changed" };
    }

    // Closed iff now >= closesAt, the same rule as the web (utils/poll-close.ts).
    // A poll whose voters the retention removed (v0.28) stays closed whatever
    // its closesAt says: "Already voted" could no longer match anybody.
    if (isPollClosed(poll.closesAt) || poll.votersRemoved) {
      return { kind: "badRequest", message: "Poll is closed" };
    }

    // Check-then-insert without a DB unique constraint (voter is a
    // link-table relation, #16, DA04). The poll's lock serialises the votes
    // of one poll; the cleanup below still collapses any duplicate a
    // database without row locks (or a vote from before the lock) left.
    const votes = strapi.db.query("api::poll-vote.poll-vote");
    const existing = await votes.findOne({
      where: { poll: poll.id, voter: voterId },
      select: ["id"],
    });
    if (existing) return { kind: "badRequest", message: "Already voted" };

    // Null when this ballot is already gone: create() inserts the row,
    // commits its relation links, then reads the row back
    // (@strapi/database entity-manager create), and a parallel vote of the
    // same voter can run the cleanup below in between and delete it.
    const vote = (await votes.create({
      data: { poll: poll.id, optionIndex, voter: voterId },
    })) as IdRow | null;

    // Keep the voter's first ballot for this poll (the lowest id, the one
    // the results count, utils/poll-ballots.ts) and delete the later ones.
    // Every vote checks AFTER its own insert, so the one that checks last
    // sees every row and leaves exactly one; the first ballot is never
    // deleted here, so one always stays. The same pattern as the reaction
    // create.
    const mine = (await votes.findMany({
      where: { poll: poll.id, voter: voterId },
      select: ["id"],
      orderBy: { id: "asc" },
    })) as IdRow[];
    const [first, ...later] = mine;
    // One entity-manager delete per row, not deleteMany: the latter is a
    // bare query-builder delete in @strapi/database 5.55.1 and would leave
    // the poll and voter link rows behind.
    for (const row of later) await votes.delete({ where: { id: row.id } });
    // This request's ballot came second (or a parallel cleanup already
    // deleted it, see create above): it does not count, the answer a vote
    // gets that finds the first ballot already there.
    if (!vote || (first && first.id !== vote.id)) {
      return { kind: "badRequest", message: "Already voted" };
    }
    return { kind: "voted", vote };
  };

  return {
    async vote(ctx) {
      const user = ctx.state.user as PollCaller | null | undefined;
      if (!user) return ctx.unauthorized();

      const body: unknown = ctx.request.body;
      const fields: VoteBody = typeof body === "object" && body !== null ? (body as VoteBody) : {};
      const { optionIndex, option: shownOption } = fields;
      if (!isOptionIndex(optionIndex)) return ctx.badRequest("optionIndex required");

      const [seen, viewer] = await Promise.all([
        loadPublishedPoll(strapi, ctx.params.id),
        loadPollViewer(strapi, user),
      ]);
      if (!seen || !canSeePoll(seen, viewer)) return ctx.notFound();

      const outcome: VoteOutcome = await strapi.db.transaction(async () => {
        // The poll's lock first (see the header), then everything again on a
        // fresh read of the published row.
        await lockDocument(strapi as unknown as DocumentLockHost, POLL_UID, seen.documentId);
        // The same address again: a row id finds nothing once a publish in
        // between replaced the published row (a 404, like any missing poll).
        const poll = await loadPublishedPoll(strapi, ctx.params.id);
        const same = poll !== null && poll.documentId === seen.documentId ? poll : null;
        return castVote(same, viewer, user.id, optionIndex, shownOption);
      });
      if (outcome.kind === "notFound") return ctx.notFound();
      if (outcome.kind === "forbidden") return ctx.forbidden(outcome.message);
      if (outcome.kind === "badRequest") return ctx.badRequest(outcome.message);
      return ctx.send({ data: outcome.vote });
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
  };
});
