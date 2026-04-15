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

async function exchangeForStrapiJwt(accessToken: string) {
  const strapiUrl = process.env.STRAPI_URL || "http://localhost:1337";
  const res = await fetch(
    `${strapiUrl}/api/auth/microsoft/callback?access_token=${encodeURIComponent(accessToken)}`,
    { method: "GET", cache: "no-store" },
  );
  if (!res.ok) {
    console.error("[auth] Strapi JWT exchange failed", res.status, await res.text());
    return null;
  }
  return (await res.json()) as {
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
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
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
        if (strapi) {
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
