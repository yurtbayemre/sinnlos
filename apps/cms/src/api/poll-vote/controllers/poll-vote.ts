import { factories } from "@strapi/strapi";

import { isPollClosed } from "../../../utils/poll-close";

export default factories.createCoreController("api::poll-vote.poll-vote", ({ strapi }) => ({
  async vote(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const pollId = Number(ctx.params.id);
    const { optionIndex } = ctx.request.body as { optionIndex?: number };
    if (optionIndex == null || optionIndex < 0) return ctx.badRequest("optionIndex required");

    // Published rows only (FX06): db.query spans draft AND published rows;
    // a draft poll id answers the same 404 as a missing one.
    const poll = await strapi.db.query("api::poll.poll").findOne({
      where: { id: pollId, publishedAt: { $notNull: true } },
    });
    if (!poll) return ctx.notFound();

    const options = poll.options as string[];
    if (optionIndex >= options.length) return ctx.badRequest("Invalid optionIndex");

    // Closed iff now >= closesAt, the same rule as the web (utils/poll-close.ts).
    if (isPollClosed(poll.closesAt)) {
      return ctx.badRequest("Poll is closed");
    }

    const existing = await strapi.db.query("api::poll-vote.poll-vote").findOne({
      where: { poll: pollId, voter: user.id },
    });
    if (existing) return ctx.badRequest("Already voted");

    const vote = await strapi.db.query("api::poll-vote.poll-vote").create({
      data: { poll: pollId, optionIndex, voter: user.id },
    });
    return ctx.send({ data: vote });
  },

  async results(ctx) {
    const pollId = Number(ctx.params.id);
    // Granted to every role incl. guest: without the pin a draft poll id
    // returned the unpublished question and options (FX06).
    const poll = await strapi.db.query("api::poll.poll").findOne({
      where: { id: pollId, publishedAt: { $notNull: true } },
    });
    if (!poll) return ctx.notFound();

    const votes = await strapi.db.query("api::poll-vote.poll-vote").findMany({
      where: { poll: pollId },
      populate: poll.anonymous ? [] : ["voter"],
    });

    const options = poll.options as string[];
    const counts = options.map((_, i) => votes.filter((v: any) => v.optionIndex === i).length);
    const total = votes.length;

    const user = ctx.state.user;
    const myVote = user
      ? votes.find((v: any) => v.voter?.id === user.id || v.voter === user.id)
      : null;

    return ctx.send({
      poll: { id: poll.id, question: poll.question, options, closesAt: poll.closesAt, anonymous: poll.anonymous },
      counts,
      total,
      myVoteIndex: myVote ? (myVote as any).optionIndex : null,
    });
  },
}));
