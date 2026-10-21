import { errors } from "@strapi/utils";

import { ADMIN, hasRole } from "../../../bootstrap/roles";
import { parseRowId } from "../../../utils/entry-id";
import {
  handRoleToEntra,
  listUsers,
  parseUserAdminQuery,
  parseUserAdminUpdate,
  updateUser,
  userDetail,
  type UserAdminHost,
} from "../../../utils/user-admin";

interface Context {
  state: { user?: { id?: unknown; role?: { type?: string } | null } };
  params: { id?: unknown };
  query?: Record<string, unknown>;
  request: { body?: unknown };
  status: number;
  body: unknown;
  set(key: string, value: string): void;
}

const host = () => strapi as unknown as UserAdminHost;

/** The admin caller's id; 401/403 otherwise (the grant alone is not trusted). */
function adminId(ctx: Context): number {
  const user = ctx.state.user;
  if (!user || typeof user.id !== "number") throw new errors.UnauthorizedError("Unauthorized");
  if (!hasRole(user, [ADMIN])) throw new errors.ForbiddenError("Forbidden");
  return user.id;
}

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
    answer(ctx, { data: await updateUser(host(), callerId, id, update) });
  },
  async roleToEntra(ctx: Context) {
    const callerId = adminId(ctx);
    noQuery(ctx);
    answer(ctx, { data: await handRoleToEntra(host(), callerId, targetId(ctx)) });
  },
};
