"use server";

/**
 * Server Actions for Auth.js. Defined at module level so Next.js can
 * assign them a stable action ID — inline closures inside Server
 * Components that close over dynamically-imported symbols (like the
 * previous topbar sign-out button) don't work reliably.
 *
 * The form actions answer machine codes (AC02); the forms translate them
 * through lib/auth/form-messages.ts. No Strapi message reaches the UI.
 */
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import type { Route } from "next";
import { CredentialsSignin } from "next-auth";
import { signIn, signOut } from "@/auth";
import { ENTRA, REGISTRATION_ENABLED, entraLogoutUrl } from "@/lib/auth-config";
import { isRateLimitedSignIn } from "@/lib/auth-errors";
import { STRAPI_URL } from "@/lib/config";
import { countsAsFailure } from "@/lib/auth/credentials";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/form-messages";
import {
  clientIpFrom,
  loginRateLimiter,
  maskIdentifier,
  type LoginAttemptOutcome,
} from "@/lib/login-rate-limit";
import { getSession } from "@/lib/session";
import { parseStrapiError } from "@/lib/strapi-error";
import { safeInternalPath } from "@/lib/utils";

export async function signInWithMicrosoft(formData: FormData) {
  // Deep-link restore: the route guard appends ?from=<pathname> and the
  // sign-in page forwards it as a hidden field. Only same-origin paths
  // pass validation (open-redirect guard).
  await signIn("microsoft-entra-id", {
    redirectTo: safeInternalPath(formData.get("from")),
  });
}

/** What the sign-in form shows (auth.error_<code>). */
export type SignInErrorCode = "invalidCredentials" | "rateLimited";

export type SignInFormState = {
  error?: SignInErrorCode;
  /**
   * The typed identifier, echoed on error: React 19 resets the form after
   * every settled action. The password is never echoed.
   */
  values?: { identifier: string };
};

export async function signInWithCredentials(
  _prev: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  const identifier = String(formData.get("identifier") ?? "");
  const values = { identifier };
  // Read-only peek (never counts as an attempt) for an honest message —
  // enforcement lives in authorize() (lib/auth/credentials.ts, issue #23),
  // which would otherwise answer like a wrong password.
  if (loginRateLimiter.isBlocked(clientIpFrom(await headers()), identifier)) {
    return { error: "rateLimited", values };
  }
  try {
    await signIn("local", {
      identifier: formData.get("identifier"),
      password: formData.get("password"),
      redirectTo: safeInternalPath(formData.get("from")),
    });
  } catch (err) {
    // Auth.js signals success via a NEXT_REDIRECT throw — rethrow it (and
    // every other Next control-flow error).
    unstable_rethrow(err);
    // Strapi's own throttle answered 429 (FX11): not a wrong password.
    if (isRateLimitedSignIn(err)) return { error: "rateLimited", values };
    // authorize() answered null (CredentialsSignin): wrong credentials, a
    // blocked attempt or Strapi unreachable — one answer, no oracle.
    if (!(err instanceof CredentialsSignin)) console.error("[auth] sign-in failed", err);
    return { error: "invalidCredentials", values };
  }
  return {};
}

/** What the register form shows (auth.error_<code>). */
export type RegisterErrorCode =
  | "registrationDisabled"
  | "missingFields"
  | "passwordTooShort"
  | "rateLimited"
  | "emailTaken"
  | "registrationFailed"
  | "accountCreatedSignInManually";

export type RegisterFormState = {
  error?: RegisterErrorCode;
  values?: { username: string; email: string };
};

/**
 * Strapi's register refusals the form names (users-permissions 5.55.1
 * controllers/auth.js, ApplicationError): every refusal there is a 400
 * ApplicationError or ValidationError, so the parsed envelope message is
 * compared exactly; anything else is "registrationFailed". The text itself
 * never reaches the UI.
 */
const REGISTER_REFUSALS: ReadonlyMap<string, RegisterErrorCode> = new Map([
  ["Email or Username are already taken", "emailTaken"],
  ["Register action is currently disabled", "registrationDisabled"],
]);

/** The code of a refused POST /api/auth/local/register. */
async function registerRefusal(res: Response): Promise<RegisterErrorCode> {
  if (res.status === 429) return "rateLimited";
  const { message } = parseStrapiError(await res.text().catch(() => ""));
  return (message && REGISTER_REFUSALS.get(message)) || "registrationFailed";
}

export async function registerLocalAccount(
  _prev: RegisterFormState,
  formData: FormData,
): Promise<RegisterFormState> {
  // Server-side gate: the register page hides itself when registration is
  // off, but the action must enforce it too — otherwise the endpoint stays
  // callable directly (e.g. with a stale form or crafted request).
  if (!REGISTRATION_ENABLED) return { error: "registrationDisabled" };
  const username = String(formData.get("username") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // React 19 resets the form after EVERY settled action, incl. error
  // returns — echo the typed values back so the form can restore them
  // (issue #30; classified-form pattern). The password is deliberately
  // NEVER echoed through the server roundtrip.
  const values = { username, email };
  if (!username || !email || !password) return { values, error: "missingFields" };
  if (password.length < PASSWORD_MIN_LENGTH) return { values, error: "passwordTooShort" };
  // Same limiter as the login (issue #23): registration is part of the auth
  // surface, so a blocked source may not probe here either. The attempt is
  // reserved before the request and settled after it (FX39).
  const clientIp = clientIpFrom(await headers());
  const ticket = loginRateLimiter.tryAcquire(clientIp, email);
  if (ticket === "blocked") return { values, error: "rateLimited" };
  // Counting rule mirrors authorize(): only real rejections (Strapi answers
  // invalid input and a taken email with 400) count, never 5xx/429 outages
  // or network errors. A created account is "neutral" too: it proves no
  // password of an existing account, so it resets nothing (the sign-in
  // below settles its own attempt).
  let outcome: LoginAttemptOutcome = "neutral";
  let res: Response | null = null;
  try {
    res = await fetch(`${STRAPI_URL}/api/auth/local/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forward the real client IP so Strapi's per-IP throttle counts per
        // client instead of pooling everyone on the web container's IP
        // (issue #23; Traefik overwrites client-spoofed values).
        "X-Forwarded-For": clientIp,
      },
      body: JSON.stringify({ username, email, password, displayName: username }),
      cache: "no-store",
      // Timeout parity with the login/exchange fetches (lib/auth).
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && countsAsFailure(res.status)) outcome = "failure";
  } catch {
    // The timeout (or a network failure) would otherwise throw uncaught out
    // of the Server Action — an opaque digest error page instead of the
    // {error} form state.
    res = null;
  } finally {
    // The transition log matches the one in authorize() so a block engaged
    // via this path is visible too.
    if (loginRateLimiter.settle(ticket, outcome)) {
      console.warn(
        `[login-rate-limit] block engaged ip=${clientIp} identifier=${maskIdentifier(email)}`,
      );
    }
  }
  if (!res) return { values, error: "registrationFailed" };
  if (!res.ok) return { values, error: await registerRefusal(res) };
  // Sign straight in with the new credentials.
  try {
    await signIn("local", { identifier: email, password, redirectTo: "/" });
  } catch (err) {
    // The success redirect (NEXT_REDIRECT) must reach Next.
    unstable_rethrow(err);
    return { values, error: "accountCreatedSignInManually" };
  }
  return {};
}

/**
 * Provider-aware sign-out:
 *
 *  1. Read the session BEFORE clearing it to learn which provider the
 *     user signed in with.
 *  2. Clear the local Auth.js session cookie (signOut with redirect:false
 *     returns a URL but does NOT throw the NEXT_REDIRECT sentinel, which
 *     lets us chain a second redirect below).
 *  3. Microsoft sessions only: redirect the browser to the tenant's
 *     end-session endpoint (https://login.microsoftonline.com/<tenant
 *     GUID>/oauth2/v2.0/logout, built from the configured tenant, lib/
 *     auth-config.ts) with `post_logout_redirect_uri` pointing back at
 *     /sign-in. Microsoft will clear its own tenant cookie before
 *     bouncing the user back, so the next "Sign in with Microsoft" click
 *     will actually prompt for credentials instead of silently
 *     auto-authenticating. Local users skip this — they'd otherwise get
 *     bounced to a Microsoft logout page.
 *
 * With Microsoft sign-in off (ENTRA_ENABLED is not '1', e.g. in DEMO_MODE
 * or after it was switched off), we fall back to a local redirect to
 * /sign-in — the local session is still cleared.
 *
 * Note: the `post_logout_redirect_uri` value MUST be registered in the
 * Entra app registration as one of its **Web redirect URIs** (next to the
 * Auth.js callback). Otherwise Microsoft ignores the parameter and leaves
 * the user on a generic Microsoft "signed out" page instead of /sign-in.
 * The Front-channel logout URL is a different setting (single sign-out,
 * called when the user signs out of another app) and is not used.
 */
export async function signOutAction() {
  const session = await getSession();
  const provider = session?.provider;

  await signOut({ redirect: false });

  // Prefer AUTH_URL, otherwise reconstruct the public origin from the
  // request headers (Traefik sets x-forwarded-*) — the old hardcoded
  // http://localhost:3000 fallback sent Microsoft users to a dead
  // post_logout_redirect_uri whenever AUTH_URL was missing.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto =
    h.get("x-forwarded-proto") ??
    (host && !host.startsWith("localhost") && !host.startsWith("127.") ? "https" : "http");
  const appUrl = process.env.AUTH_URL ?? (host ? `${proto}://${host}` : "http://localhost:3000");
  const postLogoutRedirect = `${appUrl.replace(/\/$/, "")}/sign-in`;

  // Federated logout only applies to Microsoft sessions — local users
  // would otherwise get bounced to a Microsoft logout page.
  if (provider === "microsoft-entra-id" && ENTRA) {
    // External Microsoft end-session URL — typedRoutes only models
    // internal routes, the cast is the documented escape hatch.
    redirect(entraLogoutUrl(ENTRA.tenantId, postLogoutRedirect) as Route);
  }

  redirect("/sign-in");
}
