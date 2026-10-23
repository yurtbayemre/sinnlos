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
import { clientIpFrom, normalizeIdentifier, passwordLinkRateLimiter } from "@/lib/login-rate-limit";
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
 * up. Only a flood from one IP or for one address is refused.
 */
export async function requestPasswordReset(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = normalizeIdentifier(String(formData.get("email") ?? "")).slice(0, 254);
  if (!LOCAL_ENABLED || !email.includes("@")) return { done: true };
  const ticket = passwordLinkRateLimiter.tryAcquire(clientIpFrom(await headers()), email);
  if (ticket === "blocked") return { error: "tooManyRequests" };
  passwordLinkRateLimiter.settle(ticket, "failure");
  try {
    await internalPost("/api/auth/password/forgot", { email, locale: await getUserLocale() });
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
  // Per IP and per link (its user id): guessing a token for one account
  // stays as slow as a sign-in.
  const ticket = passwordLinkRateLimiter.tryAcquire(
    clientIpFrom(await headers()),
    `set:${token.slice(0, token.indexOf("."))}`,
  );
  if (ticket === "blocked") return { error: "tooManyRequests" };
  let res: Response | null = null;
  try {
    res = await internalPost("/api/auth/password/set", { token, password });
  } catch (err) {
    console.error("[password] set-password did not reach the cms", err);
  }
  passwordLinkRateLimiter.settle(ticket, res?.status === 204 ? "success" : "failure");
  if (res?.status === 204) redirect("/sign-in?passwordSet=1");
  if (res?.status === 400) {
    const code = parseStrapiError(await res.text().catch(() => "")).details?.code;
    if (typeof code === "string" && CMS_CODES[code]) return { error: CMS_CODES[code] };
  }
  return { error: "setPasswordFailed" };
}
