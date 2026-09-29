/**
 * Server-only reader for the Strapi JWT (D-SESSION-01, deep-dive
 * decisions/01-microsoft-signin.md spec M, investigations.md #2).
 *
 * The Strapi JWT lives ONLY in the encrypted, HttpOnly Auth.js session
 * cookie. It is deliberately NOT on the Session object: the session callback
 * feeds GET /api/auth/session, which any code on the origin (or the user with
 * curl) can call — a JWT there is a 7-day bearer token for Strapi's public
 * /api/*. So the server decrypts the cookie itself via next-auth's getToken().
 * lib/session.ts getStrapiToken() is the only caller; strapi() and the raw
 * multipart/ICS fetches read the token through that seam.
 */
import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { getToken } from "next-auth/jwt";

type Env = Record<string, string | undefined>;

/**
 * Whether Auth.js uses the `__Secure-` session cookie for this request.
 * getToken() must look for the cookie under the SAME name, and decrypts with
 * that name as the salt — a mismatch reads nothing. This mirrors how Auth.js
 * picks it for the server-side auth() call (the one getSession() makes):
 *   - next-auth lib/index.js getSession(): createActionURL("session",
 *     x-forwarded-proto, headers, process.env, config)
 *   - @auth/core lib/utils/env.js createActionURL(): AUTH_URL ?? NEXTAUTH_URL
 *     when set, else `${x-forwarded-proto ?? "https"}://${host}`
 *   - @auth/core lib/init.js: defaultCookies(config.useSecureCookies ??
 *     url.protocol === "https:") → "__Secure-authjs.session-token" or
 *     "authjs.session-token" (lib/utils/cookie.js)
 * Sign-in (route handler or signIn() in a Server Action) resolves the URL the
 * same way, so the cookie it sets has this name. auth.ts sets neither
 * `useSecureCookies` nor `cookies` — adding either must be mirrored here
 * (pinned by auth.test.ts). Throws on an unparsable AUTH_URL, exactly like
 * Auth.js itself.
 */
export function usesSecureSessionCookie(env: Env, reqHeaders: Headers): boolean {
  const envUrl = env.AUTH_URL ?? env.NEXTAUTH_URL;
  if (envUrl) return new URL(envUrl).protocol === "https:";
  const proto = reqHeaders.get("x-forwarded-proto") ?? "https";
  return proto.replace(/:$/, "").toLowerCase() === "https";
}

/**
 * The Strapi JWT from the request's Auth.js session cookie, or null (no or
 * undecryptable cookie, no AUTH_SECRET). Only the Cookie header is handed to
 * getToken(): it would otherwise also accept an `Authorization: Bearer <JWE>`
 * header (@auth/core jwt.js getToken), which the session read never does.
 * The secret mirrors next-auth's setEnvDefaults (AUTH_SECRET ?? NEXTAUTH_SECRET).
 */
export async function readStrapiJwt(
  reqHeaders: Headers,
  env: Env = process.env,
): Promise<string | null> {
  const secret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!secret) return null;
  let secureCookie: boolean;
  try {
    secureCookie = usesSecureSessionCookie(env, reqHeaders);
  } catch {
    return null;
  }
  const token = await getToken({
    req: { headers: new Headers({ cookie: reqHeaders.get("cookie") ?? "" }) },
    secret,
    secureCookie,
  });
  return typeof token?.strapiJwt === "string" && token.strapiJwt !== "" ? token.strapiJwt : null;
}

/** A cookie jar as next/headers cookies() hands it out (the part used here). */
interface CookieJar {
  getAll(): { name: string; value: string }[];
}

/**
 * The request headers with the Cookie header rebuilt from the request's
 * cookie jar. They differ in one case: a Server Action that set a cookie.
 * Next then renders the page again in the same request with cookies()
 * updated but headers() as it arrived (next 16.3.4 request-store.js
 * synchronizeMutableCookies, "does this need to update headers as well?").
 * The password change (FX40, lib/profile-actions.ts) sets the session cookie
 * with the new Strapi JWT, and the cms has just revoked the old one: read
 * from the raw header, that re-render sent the revoked JWT, got 401 and
 * redirected the very tab that changed the password to /sign-in?expired=1.
 */
export function withJarCookies(requestHeaders: Headers, jar: CookieJar): Headers {
  const effective = new Headers(requestHeaders);
  const cookie = jar
    .getAll()
    .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  if (cookie) effective.set("cookie", cookie);
  else effective.delete("cookie");
  return effective;
}

/**
 * readStrapiJwt() for the current request, decrypted once per RSC render
 * (React cache(), same scope as getSession()). No Strapi response is memoised
 * here — it is a pure function of the request's cookies, as the cookie jar
 * holds them (withJarCookies: the session a Server Action just set).
 */
export const getStrapiJwt = cache(async (): Promise<string | null> => {
  const [requestHeaders, jar] = await Promise.all([headers(), cookies()]);
  return readStrapiJwt(withJarCookies(requestHeaders, jar));
});
