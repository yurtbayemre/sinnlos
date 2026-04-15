"use server";

/**
 * Server Actions for Auth.js. Defined at module level so Next.js can
 * assign them a stable action ID — inline closures inside Server
 * Components that close over dynamically-imported symbols (like the
 * previous topbar sign-out button) don't work reliably.
 */
import { redirect } from "next/navigation";
import { signOut } from "@/auth";

/**
 * Build the Microsoft Entra ID `end_session_endpoint` URL from the
 * OIDC issuer we configured for the provider.
 *
 * Entra issuer format:  https://login.microsoftonline.com/<tenant>/v2.0
 * End-session endpoint: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/logout
 */
function entraEndSessionUrl(issuer: string, postLogoutRedirectUri: string): string {
  const base = issuer.replace(/\/v2\.0\/?$/, "");
  const url = new URL(`${base}/oauth2/v2.0/logout`);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  return url.toString();
}

/**
 * Federated sign-out:
 *
 *  1. Clear the local Auth.js session cookie (signOut with redirect:false
 *     returns a URL but does NOT throw the NEXT_REDIRECT sentinel, which
 *     lets us chain a second redirect below).
 *  2. Redirect the browser to Microsoft's end_session endpoint with
 *     `post_logout_redirect_uri` pointing back at /sign-in. Microsoft
 *     will clear its own tenant cookie before bouncing the user back,
 *     so the next "Sign in with Microsoft" click will actually prompt
 *     for credentials instead of silently auto-authenticating.
 *
 * If `AUTH_MICROSOFT_ENTRA_ID_ISSUER` is not configured (e.g. running
 * against a different IdP or in DEMO_MODE), we fall back to a local
 * redirect to /sign-in — the local session is still cleared.
 *
 * Note: the `post_logout_redirect_uri` value MUST be registered in the
 * Entra app registration under **Authentication → Front-channel logout
 * URL** (or the legacy **Logout URL** field). Otherwise Microsoft
 * silently ignores the parameter and lands the user on a generic
 * Microsoft "signed out" page instead of /sign-in.
 */
export async function signOutAction() {
  await signOut({ redirect: false });

  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  const appUrl = process.env.AUTH_URL || "http://localhost:3000";
  const postLogoutRedirect = `${appUrl.replace(/\/$/, "")}/sign-in`;

  if (issuer) {
    redirect(entraEndSessionUrl(issuer, postLogoutRedirect));
  }

  redirect("/sign-in");
}
