/**
 * Auth.js (NextAuth v5) config.
 *
 * Two sign-in paths, toggled by env (see @/lib/auth-config):
 *
 *  - Microsoft Entra ID: after the user completes the OAuth dance
 *    against Microsoft, we exchange the access token for a Strapi JWT
 *    by calling Strapi's users-permissions Microsoft callback.
 *  - Local credentials: email+password are verified directly against
 *    Strapi's /api/auth/local endpoint, which returns the Strapi JWT.
 *
 * Either way the Strapi JWT is stored ONLY on the encrypted Auth.js JWT
 * (HttpOnly session cookie), never on the Session object: the session
 * callback's output is what GET /api/auth/session serves to the browser
 * (D-SESSION-01, investigations.md #2). Server code reads the token through
 * getStrapiToken() (lib/session.ts → lib/strapi-token.ts); role and
 * department come per request from getViewer() (lib/viewer.ts).
 */
import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { STRAPI_URL } from "@/lib/config";
import { LOCAL_ENABLED, MICROSOFT_ENABLED } from "@/lib/auth-config";
import { StrapiRateLimitedSignIn } from "@/lib/auth-errors";
import { clientIpFrom, loginRateLimiter, maskIdentifier } from "@/lib/login-rate-limit";
import { strapiJwtExp, strapiSessionExpired } from "@/lib/strapi-jwt";

const DEMO_MODE = process.env.DEMO_MODE === "1";
const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";

if (!IS_BUILD && DEMO_MODE && process.env.NODE_ENV === "production") {
  throw new Error("DEMO_MODE=1 must not be enabled in production — it disables all auth checks.");
}

// Half-configured Microsoft setups are almost always a mistake — warn
// (Microsoft sign-in stays disabled and local auth takes over instead).
if (
  !IS_BUILD &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) !==
    Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET)
) {
  console.warn(
    "[auth] Only one of AUTH_MICROSOFT_ENTRA_ID_ID / AUTH_MICROSOFT_ENTRA_ID_SECRET is set — " +
      "Microsoft sign-in is disabled. Set both to enable it, or clear both to silence this warning.",
  );
}

// Session / User / JWT augmentation lives in @/types/next-auth.d.ts.

// Only the identity fields are read: role and department are resolved per
// request by getViewer(), never taken from a sign-in payload.
type StrapiExchangeResponse = {
  jwt: string;
  user: {
    id: number;
    email: string;
    username: string;
    displayName?: string;
  };
};

/**
 * Exchange a Microsoft access token for a Strapi JWT via the
 * users-permissions Microsoft callback. Retries a couple of times with
 * backoff so a slow CMS cold-start (common during deploys) doesn't break
 * sign-in, and uses a short per-attempt timeout so we don't hang Auth.js
 * indefinitely if Strapi is unreachable.
 */
async function exchangeForStrapiJwt(accessToken: string): Promise<StrapiExchangeResponse | null> {
  const url = `${STRAPI_URL}/api/auth/microsoft/callback?access_token=${encodeURIComponent(accessToken)}`;

  // Retry only on transient failures (network error / 5xx). A 4xx means
  // Strapi actively rejected the token — retrying won't help.
  const maxAttempts = 3;
  const backoffMs = [0, 500, 1500];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (backoffMs[attempt]) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
    try {
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return (await res.json()) as StrapiExchangeResponse;
      }
      const body = await res.text();
      console.error(
        `[auth] Strapi JWT exchange failed (attempt ${attempt + 1}/${maxAttempts})`,
        res.status,
        body,
      );
      if (res.status < 500) return null;
    } catch (err) {
      console.error(
        `[auth] Strapi JWT exchange error (attempt ${attempt + 1}/${maxAttempts})`,
        (err as Error).message,
      );
    }
  }
  return null;
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
if (MICROSOFT_ENABLED) {
  providers.push(
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: {
        params: { scope: "openid profile email User.Read offline_access" },
      },
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
          const data = (await res.json()) as StrapiExchangeResponse;
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
 * Auth.js callbacks, exported only so auth.test.ts can drive the Microsoft
 * branch directly (the D-SESSION-01 regression pins); NextAuth() below is
 * the runtime consumer.
 */
export const callbacks = {
  async jwt({ token, account, user }) {
    if (user && user.strapiJwt) {
      // Local credentials path: authorize() already returned the Strapi JWT.
      token.strapiJwt = user.strapiJwt;
      token.strapiUserId = user.strapiUserId;
      token.strapiJwtExp = strapiJwtExp(user.strapiJwt);
      token.provider = "local";
    } else if (account?.access_token) {
      // Microsoft path: exchange the access token for a Strapi JWT.
      const strapi = await exchangeForStrapiJwt(account.access_token);
      if (!strapi) {
        // Abort sign-in instead of creating a partial session with no
        // Strapi JWT — every subsequent page load would silently fail
        // to fetch data, leaving the user stuck on an empty UI.
        throw new Error(
          "Could not exchange Microsoft access token for a Strapi session. " +
            "Check that the CMS is reachable and the users-permissions Microsoft provider is configured.",
        );
      }
      token.strapiJwt = strapi.jwt;
      token.strapiUserId = strapi.user.id;
      token.strapiJwtExp = strapiJwtExp(strapi.jwt);
      token.name = strapi.user.displayName ?? token.name;
      token.email = strapi.user.email ?? token.email;
      token.provider = "microsoft-entra-id";
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
    // a JWT here is a 7-day bearer token for Strapi's public /api/*.
    // Role/department are not session data either: use getViewer().
    const s = session as Session;
    s.provider = token.provider as string | undefined;
    s.user.id = token.strapiUserId as number | undefined;
    return session;
  },
} satisfies NonNullable<NextAuthConfig["callbacks"]>;

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // Upper bound only: 7 days = the Strapi JWT's expiresIn
  // (apps/cms/config/plugins.ts). The session actually ends when the
  // embedded Strapi JWT expires — the jwt callback above returns null then.
  // No `useSecureCookies` / `cookies` override here: lib/strapi-token.ts
  // reads the session cookie under Auth.js's default name and must mirror
  // any change (pinned by auth.test.ts).
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/sign-in" },
  providers,
  callbacks,
});
