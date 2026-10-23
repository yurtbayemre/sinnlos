/**
 * POST /api/auth/password/forgot and /set (v0.27; routes/password-auth.ts).
 *
 * forgot: always 202 with the same body, answered BEFORE any lookup, so
 * neither the answer nor its timing says whether an account exists. The
 * lookup and the mail run once the response has finished (rev3 #10), at
 * most MAX_RESET_JOBS at a time (more are dropped with a log line), only
 * for a local account bound to no identity provider that has a password
 * and is not blocked, while local sign-in is on and mail is configured;
 * the link is stamped under the row lock. The web limits the requests per
 * IP and per address.
 *
 * set: redeems a link (utils/password-link.ts): 204, or 400 with
 * details.code token_invalid / password_<problem>. No JWT.
 */
import { errors } from "@strapi/utils";

import { USER_UID } from "../../../extensions/users-permissions/strapi-server";
import { errorLabel, secretMatches } from "../../../idp/exchange-core";
import {
  accountMailReady,
  sendAccountMail,
  type AccountMailHost,
} from "../../../utils/account-mail";
import { lockUserRow, type MfaHost } from "../../../utils/mfa-core";
import { issueLink, isLocalUnbound, LINK_SELECT, redeemLink } from "../../../utils/password-link";
import { localSignInEnabled } from "../../../utils/sign-in-policy";

/** The header the web server sends INTERNAL_UPLOAD_TOKEN in. */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

interface Context {
  get(field: string): string;
  request: { body?: unknown };
  res: { once(event: "finish", listener: () => void): unknown };
  status: number;
  body: unknown;
  notFound(): unknown;
}

/** Reset requests worked on at the same time; more are dropped. */
export const MAX_RESET_JOBS = 5;
let resetJobs = 0;

type Row = Record<string, unknown>;
const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fromWebServer(ctx: Context): boolean {
  return secretMatches(ctx.get(INTERNAL_TOKEN_HEADER), process.env.INTERNAL_UPLOAD_TOKEN ?? "");
}

type Host = MfaHost & AccountMailHost & { plugin(name: string): { service(name: string): never } };

/** The detached half of forgot: never throws, never logs the address. */
export async function requestReset(strapi: Host, email: string, locale: unknown): Promise<void> {
  try {
    if (!localSignInEnabled() || !accountMailReady().ok) return;
    let mail: { to: string; token: string; name: string; locale: unknown } | null = null;
    await strapi.db.transaction(async ({ trx }) => {
      const found = await strapi.db
        .query(USER_UID)
        .findOne({ where: { email: { $eqi: email } }, select: ["id"] });
      if (!isRecord(found) || typeof found.id !== "number") return;
      await lockUserRow(strapi, trx, found.id);
      const row = await strapi.db
        .query(USER_UID)
        .findOne({ where: { id: found.id }, select: LINK_SELECT });
      if (!isRecord(row) || !isLocalUnbound(row) || row.blocked === true) return;
      if (typeof row.password !== "string" || row.password === "") return;
      const token = await issueLink(strapi, row, "reset");
      const name =
        (typeof row.displayName === "string" && row.displayName) ||
        (typeof row.username === "string" ? row.username : "");
      mail = { to: String(row.email), token, name, locale: locale ?? row.locale };
    });
    const pending = mail as { to: string; token: string; name: string; locale: unknown } | null;
    if (pending) await sendAccountMail(strapi, { ...pending, kind: "reset" });
  } catch (err) {
    strapi.log.warn(`[auth] password reset request failed (${errorLabel(err)})`);
  }
}

export default {
  async forgot(ctx: Context) {
    if (!fromWebServer(ctx)) return ctx.notFound();
    const body = isRecord(ctx.request.body) ? ctx.request.body : {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const locale = body.locale === "de" || body.locale === "en" ? body.locale : undefined;
    ctx.status = 202;
    ctx.body = { data: { accepted: true } };
    if (!EMAIL.test(email) || email.length > 255) return;
    ctx.res.once("finish", () => {
      if (resetJobs >= MAX_RESET_JOBS) {
        strapi.log.warn("[auth] password reset request dropped: too many at once");
        return;
      }
      resetJobs++;
      void requestReset(strapi as unknown as Host, email, locale).finally(() => {
        resetJobs--;
      });
    });
  },

  async set(ctx: Context) {
    if (!fromWebServer(ctx)) return ctx.notFound();
    const body = isRecord(ctx.request.body) ? ctx.request.body : {};
    if (!localSignInEnabled())
      throw new errors.ValidationError("token_invalid", { code: "token_invalid" });
    await redeemLink(strapi as unknown as Host, body.token, body.password);
    ctx.status = 204;
    ctx.body = null;
  },
};
