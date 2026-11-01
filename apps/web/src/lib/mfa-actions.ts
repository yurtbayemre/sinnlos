"use server";

/**
 * The caller's own second factor (v0.27, deep-dive v027-contract.md):
 * turn it on at /mfa/setup (also the forced step of a restricted session)
 * and off on /profile. Both answer a new Strapi JWT (the cms bumps the
 * token version), which goes into this tab's session like after a password
 * change (lib/auth/keep-session.ts). Machine codes only; the forms translate
 * them (mfa.error_<code>).
 *
 * v0.34 (A-01): both check the account's password, so both draw on one
 * attempt budget (mfaRateLimiter, lib/login-rate-limit.ts: per client IP
 * and per account, failures only). Without it a copied session could guess
 * its owner's password here without the sign-in's limit.
 */
import { headers } from "next/headers";
import { refresh } from "next/cache";
import { runCmsAction } from "@/lib/action-result";
import { keepSessionSignedIn } from "@/lib/auth/keep-session";
import { clientIpFrom, mfaRateLimiter, type LoginAttemptOutcome } from "@/lib/login-rate-limit";
import { getSession } from "@/lib/session";
import { strapi } from "@/lib/strapi";

export type MfaErrorCode =
  | "enrollmentInvalid"
  | "passwordInvalid"
  | "mfaInvalid"
  | "alreadyEnabled"
  | "notEnabled"
  | "requiredByRole"
  | "unavailable"
  | "rateLimited"
  | "failed";

/** The cms's details.code → the form's code. */
const CMS_CODES: Readonly<Record<string, MfaErrorCode>> = {
  enrollment_invalid: "enrollmentInvalid",
  password_invalid: "passwordInvalid",
  mfa_invalid: "mfaInvalid",
  already_enabled: "alreadyEnabled",
  mfa_not_enabled: "notEnabled",
  mfa_required_by_role: "requiredByRole",
  mfa_unavailable: "unavailable",
};

const mapError = (cms: { details: Readonly<Record<string, unknown>> | null }) => {
  const code = cms.details?.code;
  return typeof code === "string" ? CMS_CODES[code] : undefined;
};

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "").slice(0, 512);

/** A wrong password or code: the failures the budget counts. */
const GUESS_CODES: ReadonlySet<MfaErrorCode | undefined> = new Set([
  "passwordInvalid",
  "mfaInvalid",
]);

/**
 * Runs one activate/disable attempt inside the shared budget: refused
 * (`rateLimited`, no cms call) while the IP or the account is blocked,
 * else the attempt holds a place until it settles: a wrong password or
 * code stays counted, a success clears the account's bucket, anything else
 * (an outage, a throw, a redirect) gives the place back.
 */
async function withAttemptBudget<S extends { error?: MfaErrorCode }>(
  label: string,
  attempt: () => Promise<S>,
): Promise<S | { error: "rateLimited" }> {
  const session = await getSession();
  const id = session?.user && "id" in session.user ? session.user.id : undefined;
  const account = `user:${typeof id === "number" ? id : "none"}`;
  const ticket = mfaRateLimiter.tryAcquire(clientIpFrom(await headers()), account);
  if (ticket === "blocked") return { error: "rateLimited" };
  let outcome: LoginAttemptOutcome = "neutral";
  try {
    const state = await attempt();
    if (state.error === undefined) outcome = "success";
    else if (GUESS_CODES.has(state.error)) outcome = "failure";
    return state;
  } finally {
    if (mfaRateLimiter.settle(ticket, outcome)) {
      console.warn(`${label} too many wrong passwords or codes: ${account} blocked for a while`);
    }
  }
}

export type MfaActivateState = { recoveryCodes?: string[]; error?: MfaErrorCode };

/** Turns the second factor on with the setup page's sealed enrollment. */
export async function activateMfa(
  _prev: MfaActivateState,
  formData: FormData,
): Promise<MfaActivateState> {
  return withAttemptBudget("[mfa] activate", () => activate(formData));
}

async function activate(formData: FormData): Promise<MfaActivateState> {
  const result = await runCmsAction<
    MfaErrorCode,
    { data?: { jwt?: unknown; recoveryCodes?: unknown } },
    string[]
  >(
    () =>
      strapi("/api/me/mfa/activate", {
        method: "POST",
        body: JSON.stringify({
          enrollment: field(formData, "enrollment"),
          code: field(formData, "code").trim(),
          password: field(formData, "password"),
        }),
      }),
    {
      label: "[mfa] activate",
      mapError,
      after: (answer) => keepSessionSignedIn(answer.data?.jwt, "[mfa] activate"),
      data: (answer) =>
        Array.isArray(answer.data?.recoveryCodes)
          ? answer.data.recoveryCodes.filter((c): c is string => typeof c === "string")
          : [],
    },
  );
  if (result.ok) return { recoveryCodes: result.data ?? [] };
  return { error: isMfaCode(result.code) ? result.code : "failed" };
}

export type MfaDisableState = { success?: true; error?: MfaErrorCode };

/** Turns a voluntary second factor off (a code and the password). */
export async function disableMfa(
  _prev: MfaDisableState,
  formData: FormData,
): Promise<MfaDisableState> {
  return withAttemptBudget("[mfa] disable", () => disable(formData));
}

async function disable(formData: FormData): Promise<MfaDisableState> {
  const result = await runCmsAction<MfaErrorCode, { data?: { jwt?: unknown } }>(
    () =>
      strapi("/api/me/mfa/disable", {
        method: "POST",
        body: JSON.stringify({
          code: field(formData, "code").trim(),
          password: field(formData, "password"),
        }),
      }),
    {
      label: "[mfa] disable",
      mapError,
      after: async (answer) => {
        await keepSessionSignedIn(answer.data?.jwt, "[mfa] disable");
        refresh();
      },
    },
  );
  if (result.ok) return { success: true };
  return { error: isMfaCode(result.code) ? result.code : "failed" };
}

function isMfaCode(code: string): code is MfaErrorCode {
  return Object.values(CMS_CODES).includes(code as MfaErrorCode);
}
