"use server";

/**
 * Server Actions for Auth.js. Defined at module level so Next.js can
 * assign them a stable action ID — inline closures inside Server
 * Components that close over dynamically-imported symbols (like the
 * previous topbar sign-out button) don't work reliably.
 *
 * The form actions answer machine codes (AC02); the form translates them
 * through lib/auth/form-messages.ts. No Strapi message reaches the UI.
 */
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import type { Route } from "next";
import { CredentialsSignin } from "next-auth";
import { signIn, signOut } from "@/auth";
import { ENTRA, entraLogoutUrl } from "@/lib/auth-config";
import {
  isRateLimitedSignIn,
  MFA_INVALID_SIGN_IN_CODE,
  MFA_REQUIRED_SIGN_IN_CODE,
} from "@/lib/auth-errors";
import { clientIpFrom, loginRateLimiter } from "@/lib/login-rate-limit";
import { getSession } from "@/lib/session";
import { safeInternalPath } from "@/lib/utils";

export async function signInWithMicrosoft(formData: FormData) {
  // Deep-link restore: the route guard appends ?from=<pathname> and the
  // sign-in page forwards it as a hidden field. Only same-origin paths
  // pass validation (open-redirect guard).
  await signIn("microsoft-entra-id", {
    redirectTo: safeInternalPath(formData.get("from")),
  });
}

export async function signInWithOidc(formData: FormData) {
  // Same deep-link restore as Microsoft. Sign-out ends only the sinnlos
  // session for OIDC (no end-session call; deep-dive plan-oidc.md).
  await signIn("oidc", { redirectTo: safeInternalPath(formData.get("from")) });
}

/** What the sign-in form shows (auth.error_<code>). */
export type SignInErrorCode = "invalidCredentials" | "rateLimited" | "mfaInvalid";

export type SignInFormState = {
  error?: SignInErrorCode;
  /**
   * v0.27: the password was right and the account asks for its second
   * factor; the form shows the code field and sends all three again.
   */
  mfa?: true;
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
  // Read-only peek (never counts as an attempt): a blocked source gets its
  // answer without a sign-in round trip. Enforcement lives in authorize()
  // (lib/auth/credentials.ts, issue #23), which answers the same code when
  // parallel attempts take the last places after this peek.
  if (loginRateLimiter.isBlocked(clientIpFrom(await headers()), identifier)) {
    return { error: "rateLimited", values };
  }
  try {
    await signIn("local", {
      identifier: formData.get("identifier"),
      password: formData.get("password"),
      otp: formData.get("otp") ?? "",
      redirectTo: safeInternalPath(formData.get("from")),
    });
  } catch (err) {
    // Auth.js signals success via a NEXT_REDIRECT throw — rethrow it (and
    // every other Next control-flow error).
    unstable_rethrow(err);
    // Throttled, not a wrong password: Strapi's own throttle answered 429
    // (FX11), or the limiter refused the attempt in authorize() although
    // the pre-check above passed (parallel attempts in flight took the last
    // places in between, FX39).
    if (isRateLimitedSignIn(err)) return { error: "rateLimited", values };
    // The second factor (v0.27): asked for, or a wrong / used code.
    if (err instanceof CredentialsSignin && err.code === MFA_REQUIRED_SIGN_IN_CODE) {
      return { mfa: true, values };
    }
    if (err instanceof CredentialsSignin && err.code === MFA_INVALID_SIGN_IN_CODE) {
      return { error: "mfaInvalid", mfa: true, values };
    }
    // authorize() answered null (CredentialsSignin): wrong credentials or
    // Strapi unreachable — one answer, no oracle.
    if (!(err instanceof CredentialsSignin)) console.error("[auth] sign-in failed", err);
    return { error: "invalidCredentials", values };
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
