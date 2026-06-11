/**
 * Auth.js (NextAuth v5) config.
 *
 * We use Microsoft Entra ID as the identity provider. After the user
 * completes the OAuth dance against Microsoft, we exchange the access
 * token for a Strapi JWT by calling Strapi's users-permissions
 * Microsoft callback. That JWT is stashed on the session and every
 * server-side Strapi fetch uses it.
 */
import NextAuth, { type DefaultSession } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { STRAPI_URL } from "@/lib/config";

// Startup env validation — fail fast if the deployment is misconfigured
// rather than letting the auth flow silently break at first sign-in.
//
// Skipped during `next build` (phase-production-build) because Next.js
// evaluates page modules while collecting page data, and runtime env
// vars aren't available inside the Docker builder stage.
const DEMO_MODE = process.env.DEMO_MODE === "1";
const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";

if (!IS_BUILD && DEMO_MODE && process.env.NODE_ENV === "production") {
  throw new Error(
    "DEMO_MODE=1 must not be enabled in production — it disables all auth checks.",
  );
}

if (!IS_BUILD && !DEMO_MODE) {
  const missing: string[] = [];
  if (!process.env.AUTH_MICROSOFT_ENTRA_ID_ID) missing.push("AUTH_MICROSOFT_ENTRA_ID_ID");
  if (!process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET) missing.push("AUTH_MICROSOFT_ENTRA_ID_SECRET");
  if (missing.length) {
    throw new Error(
      `Missing required Microsoft Entra ID env vars: ${missing.join(", ")}. ` +
        `Set them in the environment, or run with DEMO_MODE=1 for a local demo.`,
    );
  }
}

declare module "next-auth" {
  interface Session {
    strapiJwt?: string;
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // maxAge matches the Strapi JWT's expiresIn (7 days, see
  // apps/cms/config/plugins.ts). Otherwise the Auth.js session outlives
  // the Strapi JWT and users silently hit 401s on every API fetch.
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/sign-in" },
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: {
        params: { scope: "openid profile email User.Read offline_access" },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
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
      }
      return token;
    },
    async session({ session, token }) {
      const s = session as any;
      s.strapiJwt = token.strapiJwt as string | undefined;
      s.user.id = token.strapiUserId as number | undefined;
      s.user.role = token.strapiRole as string | undefined;
      s.user.department = (token.strapiDepartment as any) ?? null;
      return session;
    },
  },
});
