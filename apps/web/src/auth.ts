/**
 * Auth.js (NextAuth v5) config.
 *
 * Two sign-in paths, toggled by env (see @/lib/auth-config):
 *
 *  - Microsoft Entra ID (ENTRA_ENABLED=1, D-ENTRA-01): Auth.js runs the OIDC
 *    code flow against exactly one tenant (the issuer is computed from its
 *    GUID, so a token of any other tenant fails Auth.js' own iss check).
 *    The signIn callback re-checks the tenant, then POSTs the ID token and
 *    the Graph access token to the cms (lib/entra-exchange.ts), which
 *    verifies the ID token itself, provisions the user and answers with a
 *    Strapi JWT; the result reaches the jwt callback through a WeakMap
 *    keyed by the `account` object Auth.js hands to both. A refusal
 *    becomes a redirect to /sign-in?error=entra_<code>.
 *  - Local credentials: email+password are verified directly against
 *    Strapi's /api/auth/local endpoint, which returns the Strapi JWT
 *    (lib/auth/credentials.ts, behind the login limiter).
 *
 * The callbacks live in lib/auth/callbacks.ts and the credentials check in
 * lib/auth/credentials.ts, both built from injected dependencies (WD09);
 * this module wires them to the environment and to NextAuth().
 *
 * Either way the Strapi JWT is stored ONLY on the encrypted Auth.js JWT
 * (HttpOnly session cookie), never on the Session object: the session
 * callback's output is what GET /api/auth/session serves to the browser
 * (D-SESSION-01, investigations.md #2). Server code reads the token through
 * getStrapiToken() (lib/session.ts → lib/strapi-token.ts); role and
 * department come per request from getViewer() (lib/viewer.ts). The session
 * ends when that Strapi JWT expires (ENTRA_SESSION_TTL for Entra, 7 days
 * for local).
 *
 * The @auth/core 0.41.3 behaviour this relies on (pinned in auth.test.ts):
 *  - with a GUID issuer, the Entra provider's tenant rewrite (a \w+ regex)
 *    cannot match, so discovery and the ID token's iss stay on that tenant
 *    (lib/actions/callback/oauth/callback.js);
 *  - the default profile() fetches the Graph photo outside any try/catch
 *    and puts it into the cookie; the claims-only entraProfile() replaces it;
 *  - a string returned by signIn becomes a redirect, and the same `account`
 *    object reaches jwt() (lib/actions/callback/index.js);
 *  - a jwt callback returning null clears the cookie (lib/actions/session.js).
 */
import NextAuth from "next-auth";
import MicrosoftEntraID, {
  type MicrosoftEntraIDProfile,
} from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { ENTRA, LOCAL_ENABLED } from "@/lib/auth-config";
import { createAuthCallbacks, ENTRA_PROVIDER_ID } from "@/lib/auth/callbacks";
import { authorizeCredentials } from "@/lib/auth/credentials";
import { clientIpFrom, loginRateLimiter } from "@/lib/login-rate-limit";

const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";

// The one DEMO_MODE source is lib/config.ts (WD08). The demo has no sign-in
// at all (lib/session.ts DEMO_SESSION, proxy.ts lets every request through),
// so a production server (NODE_ENV=production) must not serve it. Next loads
// this module lazily: `next start` still comes up and prints Ready, but the
// throw below fires on the first load, so every page and route that reads
// the session answers 500 with this message in the log (only the session-less
// /api/live/emit and the static files still answer), and the web healthcheck
// on / fails. It stays here rather than in instrumentation.ts: Next 16 does
// not exit on a throwing instrumentation hook either (see its header).
if (!IS_BUILD && DEMO_MODE && process.env.NODE_ENV === "production") {
  throw new Error("DEMO_MODE=1 must not be enabled in production — it disables all auth checks.");
}

// Session / User / JWT augmentation lives in @/types/next-auth.d.ts.

export { ENTRA_PROVIDER_ID };

/**
 * The claims-only profile of a Microsoft sign-in (spec C): no Graph photo
 * request, no image in the cookie. The account id is the object id; the cms
 * keys users on (tid, oid) anyway.
 */
export function entraProfile(profile: MicrosoftEntraIDProfile) {
  const claims = profile as unknown as Record<string, unknown>;
  const text = (key: string) => (typeof claims[key] === "string" ? (claims[key] as string) : null);
  const email = text("email") ?? text("preferred_username");
  return {
    id: text("oid") ?? undefined,
    name: text("name") ?? text("preferred_username"),
    email: email ? email.toLowerCase() : null,
    image: null,
  };
}

/**
 * Client IP for the current sign-in attempt. Auth.js hands authorize() the
 * incoming request (Traefik/Caddy overwrite spoofed x-forwarded-for, so the
 * first entry is the real client). The fallback reads the Server Action's
 * own request headers — dynamically imported so this module stays loadable
 * outside a request scope (e.g. during the build), mirroring proxy.ts.
 */
async function clientIpForSignIn(request: Request | undefined): Promise<string> {
  if (request?.headers) return clientIpFrom(request.headers);
  try {
    const { headers } = await import("next/headers");
    return clientIpFrom(await headers());
  } catch {
    return "unknown";
  }
}

const providers = [];
if (ENTRA) {
  providers.push(
    MicrosoftEntraID({
      clientId: ENTRA.clientId,
      clientSecret: ENTRA.clientSecret,
      // https://login.microsoftonline.com/<tenant GUID>/v2.0, never `common`.
      issuer: ENTRA.issuer,
      // No offline_access: no refresh token is requested or stored.
      authorization: { params: { scope: ENTRA.scope } },
      profile: entraProfile,
    }),
  );
}
if (LOCAL_ENABLED) {
  providers.push(
    Credentials({
      id: "local",
      name: "Email & password",
      credentials: {
        identifier: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        // Pure core with the real dependencies (WD09). The global fetch is
        // read per call, so Next's patched fetch (and a test's stub) is the
        // one used.
        return authorizeCredentials(
          {
            identifier: credentials?.identifier,
            password: credentials?.password,
            clientIp: await clientIpForSignIn(request),
          },
          {
            strapiUrl: STRAPI_URL,
            fetch: (input, init) => fetch(input, init),
            limiter: loginRateLimiter,
            now: Date.now,
            warn: (message) => console.warn(message),
          },
        );
      },
    }),
  );
}

/**
 * The Auth.js callbacks (lib/auth/callbacks.ts), exported only so
 * auth.test.ts can drive them directly as well; NextAuth() below is the
 * runtime consumer.
 */
export const callbacks = createAuthCallbacks({ entra: ENTRA, strapiUrl: STRAPI_URL });

// unstable_update: lib/profile-actions.ts hands the Strapi JWT of a password
// change to the session (FX40; the jwt callback's update branch decides).
export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  trustHost: true,
  // Upper bound only: 7 days = the local Strapi JWT's expiresIn
  // (apps/cms/config/plugins.ts; Entra sign-ins get ENTRA_SESSION_TTL, at
  // most 7d). The session actually ends when the embedded Strapi JWT
  // expires — the jwt callback (lib/auth/callbacks.ts) returns null then.
  // No `useSecureCookies` / `cookies` override here: lib/strapi-token.ts
  // reads the session cookie under Auth.js's default name and must mirror
  // any change (pinned by auth.test.ts).
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  // Errors (AccessDenied, Configuration, OAuth callback errors) land on the
  // sign-in page too, which explains entra_* codes and shows a generic
  // message for anything else.
  pages: { signIn: "/sign-in", error: "/sign-in" },
  providers,
  callbacks,
});
