"use server";

/**
 * v0.27 set-password links (deep-dive v027-contract.md): the reset request
 * of /forgot-password and the password of an invitation or reset link at
 * /set-password. Both talk to the cms's internal routes with the shared
 * INTERNAL_UPLOAD_TOKEN (the cms answers 404 without it) and answer
 * machine codes the forms translate (auth.error_<code>).
 *
 * The link token arrives from the page's URL fragment through a hidden
 * field; it is never logged and never echoed back.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { passwordLengthProblem } from "@sinnlos/domain";
import { LOCAL_ENABLED } from "@/lib/auth-config";
import { STRAPI_URL } from "@/lib/config";
import { getUserLocale } from "@/i18n/locale";
import {
  clientIpFrom,
  normalizeIdentifier,
  passwordLinkRateLimiter,
  setPasswordRateLimiter,
} from "@/lib/login-rate-limit";
import { parseStrapiError } from "@/lib/strapi-error";

/** Timeout of each cms request of these forms. */
const TIMEOUT_MS = 10_000;

/** The link token of a mail: `<user id>.<43 base64url characters>`. */
const LINK_TOKEN = /^\d{1,12}\.[A-Za-z0-9_-]{43}$/;

function internalPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${STRAPI_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": process.env.INTERNAL_UPLOAD_TOKEN ?? "",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export type ForgotPasswordState = { done?: true; error?: "tooManyRequests" };

/**
 * Asks the cms for a reset link. Always the same answer (`done`), whether
 * or not an account exists; the cms answers 202 before it looks anything
 * up. Only a flood from one IP or for one address is refused; every request
 * counts, also one the cms answered with an error or not in time.
 */
export async function requestPasswordReset(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = normalizeIdentifier(String(formData.get("email") ?? "")).slice(0, 254);
  if (!LOCAL_ENABLED || !email.includes("@")) return { done: true };
  const ticket = passwordLinkRateLimiter.tryAcquire(clientIpFrom(await headers()), email);
  if (ticket === "blocked") return { error: "tooManyRequests" };
  // Every request that got this far counts, whatever the cms answers: a
  // slow or failing cms may still send the mail, so an outage must not
  // lift the per-address and per-IP budget of reset mails.
  passwordLinkRateLimiter.settle(ticket, "failure");
  try {
    const res = await internalPost("/api/auth/password/forgot", {
      email,
      locale: await getUserLocale(),
    });
    if (!res.ok) console.error(`[password] reset request refused by the cms: ${res.status}`);
  } catch (err) {
    console.error("[password] reset request did not reach the cms", err);
  }
  return { done: true };
}

export type SetPasswordErrorCode =
  | "tokenInvalid"
  | "passwordTooShort"
  | "passwordTooLong"
  | "passwordCommon"
  | "passwordMismatch"
  | "tooManyRequests"
  | "setPasswordFailed";

export type SetPasswordState = { error?: SetPasswordErrorCode };

const CMS_CODES: Readonly<Record<string, SetPasswordErrorCode>> = {
  token_invalid: "tokenInvalid",
  password_tooShort: "passwordTooShort",
  password_tooLong: "passwordTooLong",
  password_common: "passwordCommon",
};

/** Sets the password of an invitation or reset link; success → /sign-in?passwordSet=1. */
export async function setPasswordFromLink(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!LOCAL_ENABLED || !LINK_TOKEN.test(token)) return { error: "tokenInvalid" };
  if (password !== String(formData.get("confirm") ?? "")) return { error: "passwordMismatch" };
  const length = passwordLengthProblem(password);
  if (length) return { error: length === "tooShort" ? "passwordTooShort" : "passwordTooLong" };
  // Per client IP only, in a limiter of its own (its identifier is the IP
  // itself). Never per link or user id: the id prefix is a small public
  // number, so a per-id bucket would let anyone lock a person's valid link
  // with garbage tokens for their id; and never in the forgot limiter,
  // whose identifiers are addresses anyone can submit. The token's 256
  // random bits make guessing infeasible anyway; a set password gives its
  // place back, and only the cms's refusals of the token or the password
  // count: an outage, a throttle or a timeout never blocks a valid link.
  const clientIp = clientIpFrom(await headers());
  const ticket = setPasswordRateLimiter.tryAcquire(clientIp, clientIp);
  if (ticket === "blocked") return { error: "tooManyRequests" };
  let res: Response | null = null;
  try {
    res = await internalPost("/api/auth/password/set", { token, password });
  } catch (err) {
    console.error("[password] set-password did not reach the cms", err);
  }
  const code =
    res?.status === 400
      ? parseStrapiError(await res.text().catch(() => "")).details?.code
      : undefined;
  const refusal = typeof code === "string" ? CMS_CODES[code] : undefined;
  setPasswordRateLimiter.settle(
    ticket,
    res?.status === 204 ? "success" : refusal ? "failure" : "neutral",
  );
  if (res?.status === 204) redirect("/sign-in?passwordSet=1");
  return { error: refusal ?? "setPasswordFailed" };
}
