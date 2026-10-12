/**
 * The Auth.js callbacks (WD09), built from their dependencies so they can be
 * driven without Auth.js: auth.ts creates the one instance NextAuth() uses
 * (and re-exports it for auth.test.ts); callbacks.test.ts drives a second
 * one with a stubbed exchange.
 *
 *  - signIn: local sign-ins pass; a Microsoft sign-in (D-ENTRA-01, batch 9)
 *    must be of the configured tenant and is exchanged at the cms. A string
 *    return is a redirect (@auth/core handleAuthorized), so every refusal
 *    lands on the sign-in page with an entra_* code.
 *  - jwt: stores the Strapi JWT, its `exp` and the user id on the encrypted
 *    token. The Microsoft result arrives from signIn through a WeakMap keyed
 *    by the `account` object Auth.js hands to both callbacks of one sign-in
 *    (@auth/core lib/actions/callback/index.js), so nothing else can read it
 *    and it is gone with the request. On every later session read the
 *    session ends with the Strapi JWT it carries (D-SESSION-01, batch 10):
 *    null makes Auth.js clear the cookie and auth() yield null.
 *  - jwt, trigger "update" (FX40): after a password change the cms revokes
 *    the user's older Strapi JWTs and answers with a new one, which
 *    lib/profile-actions.ts hands over through unstable_update(). The same
 *    trigger also comes from a POST /api/auth/session of the browser (with
 *    its CSRF token), whose body the browser writes. So the token takes a
 *    JWT only with the server's proof (an HMAC of the JWT under the Auth.js
 *    secret, strapiJwtUpdate(): the browser has no way to make one), only
 *    for a local session, only when the new JWT names the session's own
 *    user and has not expired (applyStrapiJwtUpdate), and never for a
 *    session that has already ended: the expiry check runs BEFORE the
 *    update. Nothing else of the update is ever read. A Microsoft session
 *    keeps its JWT: the one of the answer has the local 7-day lifetime, not
 *    ENTRA_SESSION_TTL (that session then ends with its next cms request
 *    and signs in again).
 *  - session: only id and provider reach the (public) Session object.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextAuthConfig, Session } from "next-auth";
import type { EntraWebConfig } from "@/lib/auth-config";
import { exchangeEntraSignIn, type EntraExchangeSuccess } from "@/lib/entra-exchange";
import { strapiJwtExp, strapiJwtUserId, strapiSessionExpired } from "@/lib/strapi-jwt";

/** The Auth.js provider id of the Microsoft sign-in. */
export const ENTRA_PROVIDER_ID = "microsoft-entra-id";

/** /sign-in with an error code the page explains (pages.error is /sign-in too). */
export const signInError = (code: string) => `/sign-in?error=${encodeURIComponent(code)}`;

/**
 * The data of the session update that hands a new Strapi JWT to the
 * session (FX40, lib/profile-actions.ts), made by strapiJwtUpdate() only.
 * unstable_update() types its argument as a partial Session, which this is
 * not: the one cast is there.
 */
export type StrapiJwtUpdate = { strapiJwt: string; proof: string };

/** Keeps the proof's HMAC apart from every other use of the secret. */
const UPDATE_PROOF_CONTEXT = "sinnlos/strapi-jwt-session-update/v1\n";

/**
 * The Auth.js secret, read like Auth.js itself (setEnvDefaults) and
 * lib/strapi-token.ts read it; undefined without one.
 */
export function authSecret(env: Record<string, string | undefined> = process.env) {
  return env.AUTH_SECRET || env.NEXTAUTH_SECRET || undefined;
}

function updateProof(jwt: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(UPDATE_PROOF_CONTEXT + jwt)
    .digest("base64url");
}

/**
 * The session update that hands `jwt` to the session, with its proof: an
 * HMAC of the JWT under the Auth.js secret. Server code only (the secret
 * never reaches the browser); null without a secret.
 */
export function strapiJwtUpdate(jwt: string, secret = authSecret()): StrapiJwtUpdate | null {
  return secret ? { strapiJwt: jwt, proof: updateProof(jwt, secret) } : null;
}

/** Whether `proof` is strapiJwtUpdate()'s proof of `jwt` (constant-time). */
function hasServerProof(jwt: string, proof: unknown, secret: string | undefined): boolean {
  if (!secret || typeof proof !== "string") return false;
  const expected = Buffer.from(updateProof(jwt, secret));
  const given = Buffer.from(proof);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The token fields applyStrapiJwtUpdate reads and writes (a subset of the Auth.js JWT). */
type UpdatableToken = {
  provider?: unknown;
  strapiUserId?: unknown;
  strapiJwt?: unknown;
  strapiJwtExp?: unknown;
};

/**
 * Takes the Strapi JWT of a session update into `token` (see the header):
 * true when it did. Refused, and the token left as it was: a Microsoft
 * session, an update without a string `strapiJwt` or without the server's
 * proof of it (a JWT the browser made up, whatever it claims), a JWT of
 * another user or without a user id, and one without a future `exp`. The
 * JWT is decoded, not verified: the proof says it came from the server,
 * which took it from the cms's answer.
 */
export function applyStrapiJwtUpdate(
  token: UpdatableToken,
  update: unknown,
  { nowMs = Date.now(), secret = authSecret() }: { nowMs?: number; secret?: string } = {},
): boolean {
  if (token.provider === ENTRA_PROVIDER_ID) return false;
  if (typeof update !== "object" || update === null) return false;
  const { strapiJwt: jwt, proof } = update as { strapiJwt?: unknown; proof?: unknown };
  if (typeof jwt !== "string" || jwt === "") return false;
  if (!hasServerProof(jwt, proof, secret)) return false;
  const exp = strapiJwtExp(jwt);
  const userId = strapiJwtUserId(jwt);
  if (exp === undefined || nowMs >= exp * 1000) return false;
  if (userId === undefined || userId !== token.strapiUserId) return false;
  token.strapiJwt = jwt;
  token.strapiJwtExp = exp;
  return true;
}

export interface AuthCallbackDeps {
  /** The Microsoft sign-in configuration, null while it is off. */
  entra: EntraWebConfig | null;
  /** Where the cms's Entra exchange lives. */
  strapiUrl: string;
  /** The exchange (lib/entra-exchange.ts); injectable for tests. */
  exchange?: typeof exchangeEntraSignIn;
}

export function createAuthCallbacks({
  entra,
  strapiUrl,
  exchange = exchangeEntraSignIn,
}: AuthCallbackDeps) {
  /** The cms's exchange result, from signIn to jwt of the same sign-in. */
  const entraResults = new WeakMap<object, EntraExchangeSuccess>();

  return {
    async signIn({ account, profile }) {
      if (account?.provider !== ENTRA_PROVIDER_ID) return true;
      if (!entra) return signInError("entra_unavailable");
      const tid = typeof profile?.tid === "string" ? profile.tid.toLowerCase() : "";
      if (tid !== entra.tenantId) {
        console.warn("[auth] Microsoft sign-in refused: the account belongs to another tenant");
        return signInError("entra_tenant");
      }
      const { id_token: idToken, access_token: accessToken } = account;
      if (typeof idToken !== "string" || typeof accessToken !== "string") {
        console.error("[auth] Microsoft sign-in without an ID token or access token");
        return signInError("entra_unavailable");
      }
      const result = await exchange(
        { idToken, accessToken },
        { strapiUrl, secret: entra.exchangeSecret },
      );
      if (result.ok === false) return signInError(`entra_${result.code}`);
      entraResults.set(account, result.data);
      return true;
    },
    async jwt({ token, account, user, trigger, session }) {
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
      } else if (strapiSessionExpired(token)) {
        // An ended session stays ended: checked BEFORE an update could
        // replace the JWT it carries (FX40), not only after it.
        return null;
      } else if (
        trigger === "update" &&
        session &&
        typeof session === "object" &&
        "strapiJwt" in session
      ) {
        // FX40: the JWT the cms answered a password change with.
        if (!applyStrapiJwtUpdate(token, session)) {
          console.warn(
            "[auth] session update refused: not a server-signed current Strapi JWT of this local session",
          );
        }
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
      // (NextAuthConfig.callbacks = AuthConfig["callbacks"]), which don't
      // carry our module augmentation — and @auth/core's JWT exposes an index
      // signature returning `unknown`. Our augmentation in
      // @/types/next-auth.d.ts types these fields on the `next-auth` Session
      // that auth() returns, so every call site is fully typed. Here at the
      // write site we narrow the raw token fields and the augmented session
      // explicitly (typed assertions, not `as any`).
      //
      // SECURITY (D-SESSION-01, investigations.md #2): this return value is
      // what GET /api/auth/session sends to the browser. Never copy the
      // Strapi JWT (or anything derived from the token beyond id/provider)
      // onto it — a JWT here is a bearer token for Strapi's public /api/*.
      // Role/department are not session data either: use getViewer().
      const s = session as Session;
      s.provider = token.provider as string | undefined;
      s.user.id = token.strapiUserId as number | undefined;
      return session;
    },
  } satisfies NonNullable<NextAuthConfig["callbacks"]>;
}
