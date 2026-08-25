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
 * Either way the Strapi JWT is stashed on the session and every
 * server-side Strapi fetch uses it.
 */
import NextAuth, { type Session } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { STRAPI_URL } from "@/lib/config";
import { LOCAL_ENABLED, MICROSOFT_ENABLED } from "@/lib/auth-config";
import { clientIpFrom, loginRateLimiter, maskIdentifier } from "@/lib/login-rate-limit";

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

type StrapiExchangeResponse = {
  jwt: string;
  user: {
    id: number;
    email: string;
    username: string;
    displayName?: string;
    role?: { id: number; type: string; name: string };
    department?: { id: number; name: string; slug: string };
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
              // throttle counts per ctx.ip and the CMS runs proxy:true.
              // Without this header every user shares the web container's
              // IP as ONE bucket — 10 failures/min would lock everyone out.
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
            return null;
          }
          loginRateLimiter.recordSuccess(identifier);
          const data = (await res.json()) as StrapiExchangeResponse;
          // Strapi's /api/auth/local doesn't populate role/department —
          // fetch the full user with the fresh JWT.
          const meRes = await fetch(
            `${STRAPI_URL}/api/users/me?populate[role]=true&populate[department]=true`,
            {
              headers: { Authorization: `Bearer ${data.jwt}` },
              cache: "no-store",
              signal: AbortSignal.timeout(5000),
            },
          );
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
            strapiRole: me.role?.type,
            strapiDepartment: me.department
              ? { id: me.department.id, name: me.department.name, slug: me.department.slug }
              : null,
          };
        } catch {
          return null;
        }
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // maxAge matches the Strapi JWT's expiresIn (7 days, see
  // apps/cms/config/plugins.ts). Otherwise the Auth.js session outlives
  // the Strapi JWT and users silently hit 401s on every API fetch.
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/sign-in" },
  providers,
  callbacks: {
    async jwt({ token, account, user }) {
      // Local credentials path: authorize() already returned the Strapi JWT.
      if (user && user.strapiJwt) {
        token.strapiJwt = user.strapiJwt;
        token.strapiUserId = user.strapiUserId;
        token.strapiRole = user.strapiRole;
        token.strapiDepartment = user.strapiDepartment ?? null;
        token.provider = "local";
        return token;
      }
      // Microsoft path: exchange the access token for a Strapi JWT.
      if (account?.access_token) {
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
        token.strapiRole = strapi.user.role?.type;
        token.strapiDepartment = strapi.user.department
          ? {
              id: strapi.user.department.id,
              name: strapi.user.department.name,
              slug: strapi.user.department.slug,
            }
          : null;
        token.name = strapi.user.displayName ?? token.name;
        token.email = strapi.user.email ?? token.email;
        token.provider = "microsoft-entra-id";
      }
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
      const s = session as Session;
      s.strapiJwt = token.strapiJwt as string | undefined;
      s.provider = token.provider as string | undefined;
      s.user.id = token.strapiUserId as number | undefined;
      s.user.role = token.strapiRole as string | undefined;
      s.user.department = token.strapiDepartment as {
        id: number;
        name: string;
        slug: string;
      } | null;
      return session;
    },
  },
});
