import { factories } from "@strapi/strapi";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default factories.createCoreController("api::poll.poll", () => ({
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
}));
