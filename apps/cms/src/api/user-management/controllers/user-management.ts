import { errors } from "@strapi/utils";

import { anonymisePreview, anonymiseUser, type AnonymiseHost } from "../../../utils/anonymise";
import { trainingEvidenceRows } from "../../../utils/training-evidence";
import { exportUser, type ExportHost } from "../../../utils/user-export";

import { ADMIN, hasRole } from "../../../bootstrap/roles";
import { parseRowId } from "../../../utils/entry-id";
import { answerRefusals } from "../../../utils/refusal";
import {
  assertActiveAdmin,
  handRoleToEntra,
  inviteUser,
  listUsers,
  parseUserAdminInvite,
  parseUserAdminQuery,
  parseUserAdminUpdate,
  resetUserMfa,
  sendLink,
  updateUser,
  userDetail,
  type UserAdminHost,
} from "../../../utils/user-admin";

interface Context {
  state: { user?: { id?: unknown; role?: { type?: string } | null }; assurance?: { tv: number } };
  params: { id?: unknown };
  query?: Record<string, unknown>;
  request: { body?: unknown };
  status: number;
  body: unknown;
  set(key: string, value: string): void;
}

const host = () => strapi as unknown as UserAdminHost;
const anonymiseHost = () => strapi as unknown as AnonymiseHost;
const USER_UID = "plugin::users-permissions.user";

/** The admin caller's id; 401/403 otherwise (the grant alone is not trusted). */
function adminId(ctx: Context): number {
  const user = ctx.state.user;
  if (!user || typeof user.id !== "number") throw new errors.UnauthorizedError("Unauthorized");
  if (!hasRole(user, [ADMIN])) throw new errors.ForbiddenError("Forbidden");
  return user.id;
}

/** The token version the caller's JWT was verified at (every write re-checks it under lock). */
const tvOf = (ctx: Context) => ctx.state.assurance?.tv;

function targetId(ctx: Context): number {
  const id = parseRowId(ctx.params.id);
  if (id === null) throw new errors.NotFoundError("Not Found");
  return id;
}

function noQuery(ctx: Context): void {
  if (Object.keys(ctx.query ?? {}).length > 0)
    throw new errors.ValidationError("This route takes no query");
}

function answer(ctx: Context, data: unknown): void {
  ctx.set("Cache-Control", "private, no-store");
  ctx.status = 200;
  ctx.body = data;
}

/** User administration (v0.23, utils/user-admin.ts): admin_role only. */
export default {
  async list(ctx: Context) {
    adminId(ctx);
    const query = parseUserAdminQuery(ctx.query ?? {});
    if (!query) throw new errors.ValidationError("Invalid user query");
    answer(ctx, await listUsers(host(), query));
  },
  async findOne(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    answer(ctx, { data: await userDetail(host(), targetId(ctx), callerId) });
  },
  async update(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    const id = targetId(ctx);
    const update = parseUserAdminUpdate(ctx.request.body);
    await answerRefusals(ctx, async () => {
      answer(ctx, { data: await updateUser(host(), callerId, tvOf(ctx), id, update) });
    });
  },
  async roleToEntra(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    const id = targetId(ctx);
    await answerRefusals(ctx, async () => {
      answer(ctx, { data: await handRoleToEntra(host(), callerId, tvOf(ctx), id) });
    });
  },
  async invite(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    const invite = parseUserAdminInvite(ctx.request.body);
    await answerRefusals(ctx, async () => {
      answer(ctx, { data: await inviteUser(host(), callerId, tvOf(ctx), invite) });
      ctx.status = 201;
    });
  },
  async sendLink(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    const id = targetId(ctx);
    await answerRefusals(ctx, async () => {
      answer(ctx, { data: await sendLink(host(), callerId, tvOf(ctx), id) });
    });
  },
  async resetMfa(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    const id = targetId(ctx);
    await answerRefusals(ctx, async () => {
      answer(ctx, { data: await resetUserMfa(host(), callerId, tvOf(ctx), id) });
    });
  },

  // v0.28 (utils/training-evidence.ts, utils/user-export.ts, utils/anonymise.ts).
  async trainingEvidence(ctx: Context) {
    adminId(ctx);
    noQuery(ctx);
    const id = targetId(ctx);
    const user = (await strapi.db.query(USER_UID).findOne({
      where: { id },
      select: ["id", "displayName", "username"],
    })) as { displayName?: unknown; username?: unknown } | null;
    if (!user) throw new errors.NotFoundError("Not Found");
    const displayName = [user.displayName, user.username].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    answer(ctx, {
      data: {
        user: { id, displayName: displayName ?? "" },
        rows: await trainingEvidenceRows(strapi, id),
      },
    });
  },
  async export(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    const id = targetId(ctx);
    await answerRefusals(ctx, async () => {
      // The caller check of every user administration write (the export records an audit row).
      await host().db.transaction(({ trx }) => assertActiveAdmin(host(), trx, callerId, tvOf(ctx)));
      const instance = process.env.PUBLIC_WEB_URL?.trim() || null;
      answer(ctx, await exportUser(strapi as unknown as ExportHost, id, callerId, instance));
    });
  },
  async anonymisePreview(ctx: Context) {
    adminId(ctx);
    noQuery(ctx);
    answer(ctx, { data: await anonymisePreview(anonymiseHost(), targetId(ctx)) });
  },
  async anonymise(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    const id = targetId(ctx);
    const body = ctx.request.body as
      { data?: { confirm?: unknown }; confirm?: unknown } | undefined;
    const confirm = body?.data?.confirm ?? body?.confirm;
    await answerRefusals(ctx, async () => {
      answer(ctx, { data: await anonymiseUser(anonymiseHost(), callerId, tvOf(ctx), id, confirm) });
    });
  },
};
