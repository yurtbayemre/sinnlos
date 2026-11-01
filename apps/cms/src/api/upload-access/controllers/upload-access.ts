/**
 * POST /api/auth/uploads/access (routes/upload-access.ts): `{ name }`, the
 * file name of `/uploads/<name>`, in; `{ data: { allow } }` out, decided by
 * utils/upload-access.ts for the authenticated viewer. An unknown file is
 * `allow: false` like a forbidden one.
 *
 * The web server proves itself with INTERNAL_UPLOAD_TOKEN (x-internal-token);
 * without a configured token the check is skipped outside production only,
 * like the /uploads gate (middlewares/uploads-auth.ts), so a development cms
 * without the secret still shows its media.
 */
import { errors } from "@strapi/utils";

import { secretMatches } from "../../../idp/exchange-core";
import { mayOpenUpload, type UploadViewer } from "../../../utils/upload-access";
import { INTERNAL_TOKEN_HEADER } from "../../password-auth/controllers/password-auth";

interface Context {
  get(field: string): string;
  request: { body?: unknown };
  state: { user?: unknown };
  body: unknown;
  notFound(): unknown;
}

/** The longest name looked up: Strapi's names are far shorter. */
export const MAX_NAME_LENGTH = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function fromWebServer(header: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.INTERNAL_UPLOAD_TOKEN ?? "";
  if (expected === "") return env.NODE_ENV !== "production";
  return secretMatches(header, expected);
}

export default {
  async check(ctx: Context) {
    if (!fromWebServer(ctx.get(INTERNAL_TOKEN_HEADER))) return ctx.notFound();
    const body = isRecord(ctx.request.body) ? ctx.request.body : {};
    const name = body.name;
    if (typeof name !== "string" || name === "" || name.length > MAX_NAME_LENGTH) {
      throw new errors.ValidationError("name is required");
    }
    const user = ctx.state.user;
    if (!isRecord(user) || typeof user.id !== "number") throw new errors.UnauthorizedError();
    const allow = await mayOpenUpload(strapi, user as unknown as UploadViewer, name);
    ctx.body = { data: { allow } };
  },
};
