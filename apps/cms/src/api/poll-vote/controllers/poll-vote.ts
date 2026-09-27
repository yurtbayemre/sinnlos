import { factories } from "@strapi/strapi";

import { loadPollViewer, loadPublishedPoll, type PollCaller } from "../../../utils/poll-access";
import { canSeePoll, isInPollAudience, isPollTargeted } from "../../../utils/poll-audience";
import { isPollClosed } from "../../../utils/poll-close";

/**
 * The only interface to poll votes (the generic /api/poll-votes routes do
 * not exist, routes/poll-vote.ts): POST /polls/:id/vote and
 * GET /polls/:id/results, `:id` = the numeric id of the PUBLISHED poll row.
 *
 * Department targeting (decision 02, rules in utils/poll-audience.ts) is
 * checked here, not by a route policy:
 *   - a missing id, a malformed id, a draft row and a poll outside the
 *     caller's audience all answer the SAME 404 (no existence oracle);
 *   - admin_role/editor read every poll and its results, but voting takes
 *     audience membership (403 for them outside it; nobody else can get
 *     that far);
 *   - the voter is always the caller: the body's `poll`/`voter` are never
 *     read.
 * Results never name a voter. They include the caller's own vote even on
 * anonymous polls (FX20: the card needs it to show "you voted").
 */

interface OptionIndexRow {
  optionIndex?: unknown;
}

const isOptionIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

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

    // Never populate `voter`: the response carries counts and the caller's
    // own vote only, whatever `anonymous` says.
    // id must stay in the select: a relation filter makes @strapi/database
    // add DISTINCT (query-builder.js shouldUseDistinct), and without the
    // primary key identical votes collapse into one row.
    const votes = strapi.db.query("api::poll-vote.poll-vote");
    const [rows, mine] = (await Promise.all([
      votes.findMany({ where: { poll: poll.id }, select: ["id", "optionIndex"] }),
      votes.findOne({ where: { poll: poll.id, voter: user.id }, select: ["optionIndex"] }),
    ])) as [OptionIndexRow[], OptionIndexRow | null];

    const options = pollOptions(poll.options);
    const counts = options.map((_, i) => rows.filter((row) => row.optionIndex === i).length);

    return ctx.send({
      poll: {
        id: poll.id,
        question: poll.question,
        options,
        closesAt: poll.closesAt,
        anonymous: poll.anonymous ?? false,
      },
      counts,
      total: rows.length,
      myVoteIndex: isOptionIndex(mine?.optionIndex) ? mine.optionIndex : null,
      canVote: isInPollAudience(poll, viewer),
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
