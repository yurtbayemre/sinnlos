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
 *    Strapi's /api/auth/local endpoint, which returns the Strapi JWT.
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
import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import MicrosoftEntraID, {
  type MicrosoftEntraIDProfile,
} from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { ENTRA, LOCAL_ENABLED } from "@/lib/auth-config";
import { StrapiRateLimitedSignIn } from "@/lib/auth-errors";
import { exchangeEntraSignIn, type EntraExchangeSuccess } from "@/lib/entra-exchange";
import { clientIpFrom, loginRateLimiter, maskIdentifier } from "@/lib/login-rate-limit";
import { strapiJwtExp, strapiSessionExpired } from "@/lib/strapi-jwt";

const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";

// The one DEMO_MODE source is lib/config.ts (WD08). A production server
// refuses to start with it: the demo has no sign-in at all (lib/session.ts
// DEMO_SESSION, proxy.ts lets every request through).
if (!IS_BUILD && DEMO_MODE && process.env.NODE_ENV === "production") {
  throw new Error("DEMO_MODE=1 must not be enabled in production — it disables all auth checks.");
}

// Session / User / JWT augmentation lives in @/types/next-auth.d.ts.

/** The Auth.js provider id of the Microsoft sign-in. */
export const ENTRA_PROVIDER_ID = "microsoft-entra-id";

// Only the identity fields are read: role and department are resolved per
// request by getViewer(), never taken from a sign-in payload.
type StrapiLocalResponse = {
  jwt: string;
  user: {
    id: number;
    email: string;
    username: string;
    displayName?: string;
  };
};

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
 * The cms's exchange result, from the signIn callback to the jwt callback
 * of the same sign-in: Auth.js passes the SAME `account` object to both
 * (@auth/core lib/actions/callback/index.js), so nothing else can read it
 * and it is gone with the request.
 */
const entraResults = new WeakMap<object, EntraExchangeSuccess>();

/** /sign-in with an error code the page explains (pages.error is /sign-in too). */
const signInError = (code: string) => `/sign-in?error=${encodeURIComponent(code)}`;

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
        const identifier = credentials?.identifier as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!identifier || !password) return null;
        // Rate-limit BEFORE touching Strapi — the authoritative gate for
        // issue #23. Both entry points land here (the sign-in Server Action
        // AND a raw POST /api/auth/callback/local), so a limiter on either
        // outer path alone would be bypassable.
        const clientIp = await clientIpForSignIn(request);
        if (loginRateLimiter.isBlocked(clientIp, identifier)) {
          // No log here: the transition INTO the block state is logged once
          // below (recordFailure returns it) — logging every rejected
          // follow-up would let a script generate ~100 log lines/s through
          // the /api/auth callback (edge limit is 100/s).
          return null;
        }
        try {
          const res = await fetch(`${STRAPI_URL}/api/auth/local`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Forward the real client IP: Strapi's users-permissions
              // throttle keys /auth/local on ctx.request.ip, which honours
              // this header only since server.proxy.koa (FX11). Without it
              // every user shares the web container's IP as ONE bucket —
              // 10 requests/min would lock everyone out.
              "X-Forwarded-For": clientIp,
            },
            body: JSON.stringify({ identifier, password }),
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) {
            // Only genuine verification failures count — Strapi answers bad
            // credentials with 400. 5xx and 429 mean Strapi/DB trouble, not
            // a wrong password: counting those would keep legitimate retry
            // users locked out for up to 15 min AFTER an outage recovers.
            // Network errors (the catch below) don't count either.
            if (res.status < 500 && res.status !== 429) {
              const justBlocked = loginRateLimiter.recordFailure(clientIp, identifier);
              if (justBlocked) {
                // Logged once per lock window, at the transition. The full
                // IP is intentional: this is a security log of an attack
                // pattern (legitimate interest) and the IP is what an admin
                // needs to correlate with edge logs or block upstream.
                console.warn(
                  `[login-rate-limit] block engaged ip=${clientIp} identifier=${maskIdentifier(identifier)}`,
                );
              }
            }
            // Strapi's own throttle: a distinct error so the form says "too
            // many attempts" instead of "invalid email or password" (FX11).
            if (res.status === 429) throw new StrapiRateLimitedSignIn();
            return null;
          }
          loginRateLimiter.recordSuccess(identifier);
          const data = (await res.json()) as StrapiLocalResponse;
          // Display name and id of the fresh user. Role and department are
          // NOT taken here (D-SESSION-01): getViewer() reads them per request
          // from /api/me — /users/me strips `role` for every non-admin caller
          // anyway (see lib/viewer.ts).
          const meRes = await fetch(`${STRAPI_URL}/api/users/me`, {
            headers: { Authorization: `Bearer ${data.jwt}` },
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          const me = meRes.ok ? await meRes.json() : data.user;
          return {
            id: String(me.id),
            name: me.displayName ?? me.username,
            // Take the email from the /api/auth/local response, NOT from
            // /api/users/me: the latter now runs through the content-api
            // sanitizer (issue #10), which strips email for non-privileged
            // roles (guest / the pre-role-mapping `authenticated` fallback),
            // so me.email would be undefined for them. The auth endpoint's
            // user payload is not sanitized and always carries the real email.
            // (Session identity is the id/JWT, never the email — this only
            // fixes the displayed address; F4.)
            email: data.user.email ?? me.email,
            strapiJwt: data.jwt,
            strapiUserId: me.id,
          };
        } catch (e) {
          if (e instanceof StrapiRateLimitedSignIn) throw e;
          return null;
        }
      },
    }),
  );
}

/**
 * Auth.js callbacks, exported only so auth.test.ts can drive them directly
 * as well; NextAuth() below is the runtime consumer.
 */
export const callbacks = {
  /**
   * Spec C: local sign-ins pass; a Microsoft sign-in must be of the
   * configured tenant and is exchanged at the cms. A string return is a
   * redirect (@auth/core handleAuthorized), so every refusal lands on the
   * sign-in page with an entra_* code instead of a generic error.
   */
  async signIn({ account, profile }) {
    if (account?.provider !== ENTRA_PROVIDER_ID) return true;
    if (!ENTRA) return signInError("entra_unavailable");
    const tid = typeof profile?.tid === "string" ? profile.tid.toLowerCase() : "";
    if (tid !== ENTRA.tenantId) {
      console.warn("[auth] Microsoft sign-in refused: the account belongs to another tenant");
      return signInError("entra_tenant");
    }
    const { id_token: idToken, access_token: accessToken } = account;
    if (typeof idToken !== "string" || typeof accessToken !== "string") {
      console.error("[auth] Microsoft sign-in without an ID token or access token");
      return signInError("entra_unavailable");
    }
    const result = await exchangeEntraSignIn(
      { idToken, accessToken },
      { strapiUrl: STRAPI_URL, secret: ENTRA.exchangeSecret },
    );
    if (result.ok === false) return signInError(`entra_${result.code}`);
    entraResults.set(account, result.data);
    return true;
  },
  async jwt({ token, account, user }) {
    if (account?.provider === ENTRA_PROVIDER_ID) {
      // The signIn callback of this same sign-in stored the cms's answer.
      const result = entraResults.get(account);
      if (!result) throw new Error("[auth] Microsoft sign-in without an exchange result");
      entraResults.delete(account);
      token.strapiJwt = result.jwt;
      token.strapiUserId = result.user.id;
      token.strapiJwtExp = result.expiresAt;
      token.name = result.user.displayName;
      token.email = result.user.email;
      token.provider = ENTRA_PROVIDER_ID;
      delete token.picture;
    } else if (user && user.strapiJwt) {
      // Local credentials path: authorize() already returned the Strapi JWT.
      token.strapiJwt = user.strapiJwt;
      token.strapiUserId = user.strapiUserId;
      token.strapiJwtExp = strapiJwtExp(user.strapiJwt);
      token.provider = "local";
    }
    // Runs on sign-in AND on every later session read (auth(), proxy,
    // /api/auth/session): the Auth.js session ends with the Strapi JWT it
    // carries (D-SESSION-01). The cookie itself slides, so maxAge alone
    // cannot do this; a null return makes Auth.js clear the cookie
    // (@auth/core lib/actions/session.js) and auth() yield null.
    if (strapiSessionExpired(token)) return null;
    return token;
  },
  async session({ session, token }) {
    // The session/jwt callbacks are typed against @auth/core's Session/JWT
    // (NextAuthConfig.callbacks = AuthConfig["callbacks"]), which don't carry
    // our module augmentation — and @auth/core's JWT exposes an index
    // signature returning `unknown`. Our augmentation in
    // @/types/next-auth.d.ts types these fields on the `next-auth` Session
    // that auth() returns, so every call site is fully typed. Here at the
    // write site we narrow the raw token fields and the augmented session
    // explicitly (typed assertions, not `as any`).
    //
    // SECURITY (D-SESSION-01, investigations.md #2): this return value is
    // what GET /api/auth/session sends to the browser. Never copy the Strapi
    // JWT (or anything derived from the token beyond id/provider) onto it —
    // a JWT here is a bearer token for Strapi's public /api/*.
    // Role/department are not session data either: use getViewer().
    const s = session as Session;
    s.provider = token.provider as string | undefined;
    s.user.id = token.strapiUserId as number | undefined;
    return session;
  },
} satisfies NonNullable<NextAuthConfig["callbacks"]>;

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // Upper bound only: 7 days = the local Strapi JWT's expiresIn
  // (apps/cms/config/plugins.ts; Entra sign-ins get ENTRA_SESSION_TTL, at
  // most 7d). The session actually ends when the embedded Strapi JWT
  // expires — the jwt callback above returns null then.
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
