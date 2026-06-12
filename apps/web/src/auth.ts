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
import NextAuth, { type DefaultSession } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { STRAPI_URL } from "@/lib/config";
import { LOCAL_ENABLED, MICROSOFT_ENABLED } from "@/lib/auth-config";

const DEMO_MODE = process.env.DEMO_MODE === "1";
const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";

if (!IS_BUILD && DEMO_MODE && process.env.NODE_ENV === "production") {
  throw new Error(
    "DEMO_MODE=1 must not be enabled in production — it disables all auth checks.",
  );
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

declare module "next-auth" {
  interface Session {
    strapiJwt?: string;
    provider?: string;
    user: {
      id?: number;
      role?: string;
      department?: { id: number; name: string; slug: string } | null;
    } & DefaultSession["user"];
  }
}

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
async function exchangeForStrapiJwt(
  accessToken: string,
): Promise<StrapiExchangeResponse | null> {
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
      async authorize(credentials) {
        const identifier = credentials?.identifier as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!identifier || !password) return null;
        try {
          const res = await fetch(`${STRAPI_URL}/api/auth/local`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier, password }),
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return null;
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
            email: me.email,
            strapiJwt: data.jwt,
            strapiUserId: me.id,
            strapiRole: me.role?.type,
            strapiDepartment: me.department
              ? { id: me.department.id, name: me.department.name, slug: me.department.slug }
              : null,
          } as any;
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
      if (user && (user as any).strapiJwt) {
        const u = user as any;
        token.strapiJwt = u.strapiJwt;
        token.strapiUserId = u.strapiUserId;
        token.strapiRole = u.strapiRole;
        token.strapiDepartment = u.strapiDepartment ?? null;
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
      const s = session as any;
      s.strapiJwt = token.strapiJwt as string | undefined;
      s.provider = token.provider as string | undefined;
      s.user.id = token.strapiUserId as number | undefined;
      s.user.role = token.strapiRole as string | undefined;
      s.user.department = (token.strapiDepartment as any) ?? null;
      return session;
    },
  },
});
