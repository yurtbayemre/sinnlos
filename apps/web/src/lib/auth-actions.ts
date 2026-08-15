"use server";

/**
 * Server Actions for Auth.js. Defined at module level so Next.js can
 * assign them a stable action ID — inline closures inside Server
 * Components that close over dynamically-imported symbols (like the
 * previous topbar sign-out button) don't work reliably.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signIn, signOut } from "@/auth";
import { REGISTRATION_ENABLED } from "@/lib/auth-config";
import { STRAPI_URL } from "@/lib/config";
import { safeInternalPath } from "@/lib/utils";

export async function signInWithMicrosoft(formData: FormData) {
  // Deep-link restore: the route guard appends ?from=<pathname> and the
  // sign-in page forwards it as a hidden field. Only same-origin paths
  // pass validation (open-redirect guard).
  await signIn("microsoft-entra-id", {
    redirectTo: safeInternalPath(formData.get("from")),
  });
}

export async function signInWithCredentials(_prev: unknown, formData: FormData) {
  try {
    await signIn("local", {
      identifier: formData.get("identifier"),
      password: formData.get("password"),
      redirectTo: safeInternalPath(formData.get("from")),
    });
  } catch (err) {
    // Auth.js signals success via a NEXT_REDIRECT throw — rethrow it.
    if ((err as any)?.digest?.startsWith?.("NEXT_REDIRECT")) throw err;
    return { error: "Invalid email or password." };
  }
  return { error: undefined };
}

export async function registerLocalAccount(_prev: unknown, formData: FormData) {
  // Server-side gate: the register page hides itself when registration is
  // off, but the action must enforce it too — otherwise the endpoint stays
  // callable directly (e.g. with a stale form or crafted request).
  if (!REGISTRATION_ENABLED) {
    const t = await getTranslations("auth");
    return { error: t("registrationDisabled") };
  }
  const username = String(formData.get("username") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !email || password.length < 6) {
    return { error: "Fill in all fields; password needs at least 6 characters." };
  }
  const res = await fetch(`${STRAPI_URL}/api/auth/local/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password, displayName: username }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: body?.error?.message ?? "Registration failed." };
  }
  // Sign straight in with the new credentials.
  try {
    await signIn("local", { identifier: email, password, redirectTo: "/" });
  } catch (err) {
    if ((err as any)?.digest?.startsWith?.("NEXT_REDIRECT")) throw err;
    return { error: "Account created — sign in manually." };
  }
  return { error: undefined };
}

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
 * Provider-aware sign-out:
 *
 *  1. Read the session BEFORE clearing it to learn which provider the
 *     user signed in with.
 *  2. Clear the local Auth.js session cookie (signOut with redirect:false
 *     returns a URL but does NOT throw the NEXT_REDIRECT sentinel, which
 *     lets us chain a second redirect below).
 *  3. Microsoft sessions only: redirect the browser to Microsoft's
 *     end_session endpoint with `post_logout_redirect_uri` pointing back
 *     at /sign-in. Microsoft will clear its own tenant cookie before
 *     bouncing the user back, so the next "Sign in with Microsoft" click
 *     will actually prompt for credentials instead of silently
 *     auto-authenticating. Local users skip this — they'd otherwise get
 *     bounced to a Microsoft logout page.
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
  const session = await auth();
  const provider = session?.provider;

  await signOut({ redirect: false });

  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  // Prefer AUTH_URL, otherwise reconstruct the public origin from the
  // request headers (Traefik sets x-forwarded-*) — the old hardcoded
  // http://localhost:3000 fallback sent Microsoft users to a dead
  // post_logout_redirect_uri whenever AUTH_URL was missing.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto =
    h.get("x-forwarded-proto") ??
    (host && !host.startsWith("localhost") && !host.startsWith("127.")
      ? "https"
      : "http");
  const appUrl =
    process.env.AUTH_URL ?? (host ? `${proto}://${host}` : "http://localhost:3000");
  const postLogoutRedirect = `${appUrl.replace(/\/$/, "")}/sign-in`;

  // Federated logout only applies to Microsoft sessions — local users
  // would otherwise get bounced to a Microsoft logout page.
  if (provider === "microsoft-entra-id" && issuer) {
    redirect(entraEndSessionUrl(issuer, postLogoutRedirect));
  }

  redirect("/sign-in");
}
