import { factories } from "@strapi/strapi";

export default factories.createCoreController("api::poll-vote.poll-vote", ({ strapi }) => ({
  async vote(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const pollId = Number(ctx.params.id);
    const { optionIndex } = ctx.request.body as { optionIndex?: number };
    if (optionIndex == null || optionIndex < 0) return ctx.badRequest("optionIndex required");

    const poll = await strapi.db.query("api::poll.poll").findOne({
      where: { id: pollId },
    });
    if (!poll) return ctx.notFound();

    const options = poll.options as string[];
    if (optionIndex >= options.length) return ctx.badRequest("Invalid optionIndex");

    if (poll.closesAt && new Date(poll.closesAt) < new Date()) {
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
    const poll = await strapi.db.query("api::poll.poll").findOne({
      where: { id: pollId },
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
