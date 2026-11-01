import { STAFF_ROLES, hasRole } from "@sinnlos/domain";

import type { RequestAssurance } from "../../../extensions/users-permissions/strapi-server";
import { answerRefusals } from "../../../utils/refusal";
import {
  createShare,
  listShares,
  parseCreate,
  refuseShare,
  reserveCreate,
  revealShare,
  revokeShare,
  shareDetail,
  shareRecipients,
  type SecretShareHost,
} from "../../../utils/secret-shares";

/**
 * Secret sharing (v0.35.0): the six actions of routes/secret-share.ts. Every
 * one needs a signed-in staff member (an API token has no user and gets
 * 401). Refusals carry the contract's status and code
 * (@sinnlos/domain SECRET_SHARE_REFUSALS); the text is never echoed. The
 * answers are never cached (also middlewares/secret-shares-no-store.ts).
 */
interface ShareContext {
  status: number;
  body: unknown;
  params: { id?: unknown };
  query: unknown;
  state: {
    user?: { id: number; role?: { type?: string | null } | null } | null;
    assurance?: RequestAssurance;
  };
  request: { body?: unknown };
  send(body: unknown): unknown;
  unauthorized(): unknown;
  forbidden(): unknown;
}

const host = () => strapi as unknown as SecretShareHost;

/** The staff caller, or the 401/403 answer (null). */
function staffOf(ctx: ShareContext) {
  const user = ctx.state.user;
  if (!user || typeof user.id !== "number") {
    ctx.unauthorized();
    return null;
  }
  if (!hasRole(user as never, STAFF_ROLES)) {
    ctx.forbidden();
    return null;
  }
  return { userId: user.id, assurance: ctx.state.assurance };
}

export default {
  async create(ctx: ShareContext) {
    const caller = staffOf(ctx);
    if (!caller) return;
    await answerRefusals(ctx, async () => {
      const input = parseCreate(ctx.request.body, caller.userId);
      // Synchronously, before the first await (plan §3.4).
      if (!reserveCreate(caller.userId)) refuseShare("quota");
      ctx.status = 201;
      ctx.body = { data: await createShare(host(), caller, input) };
    });
  },

  async list(ctx: ShareContext) {
    const caller = staffOf(ctx);
    if (!caller) return;
    ctx.send({ data: await listShares(host(), caller.userId, ctx.query) });
  },

  async findOne(ctx: ShareContext) {
    const caller = staffOf(ctx);
    if (!caller) return;
    ctx.send({ data: await shareDetail(host(), caller.userId, ctx.params.id, ctx.query) });
  },

  async reveal(ctx: ShareContext) {
    const caller = staffOf(ctx);
    if (!caller) return;
    await answerRefusals(ctx, async () => {
      ctx.send({ data: { text: await revealShare(host(), caller, ctx.params.id) } });
    });
  },

  async revoke(ctx: ShareContext) {
    const caller = staffOf(ctx);
    if (!caller) return;
    await answerRefusals(ctx, async () => {
      ctx.send({ data: await revokeShare(host(), caller, ctx.params.id) });
    });
  },

  async recipients(ctx: ShareContext) {
    const caller = staffOf(ctx);
    if (!caller) return;
    ctx.send({ data: await shareRecipients(host(), caller.userId, ctx.query) });
  },
};
