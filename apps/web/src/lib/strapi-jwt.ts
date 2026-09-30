/**
 * Lifetime of the Strapi JWT embedded in the Auth.js session (D-SESSION-01,
 * deep-dive decisions/01-microsoft-signin.md spec C/M).
 *
 * The Auth.js cookie slides: every session read re-encodes it with a fresh
 * expiry (@auth/core lib/actions/session.js), so `session.maxAge` alone
 * cannot keep it from outliving the Strapi JWT it carries. The jwt callback
 * in @/auth therefore records the Strapi JWT's `exp` at sign-in and returns
 * null once it has passed — Auth.js then clears the cookie and auth() yields
 * null, for the local and the Microsoft path alike.
 *
 * Pure (no Next/Auth.js imports) so the jwt callback and the tests share it.
 *
 * Since FX40 a password change revokes the user's older Strapi JWTs (the
 * cms's token version); the session of the tab that changed it takes the
 * new JWT through a session update, which the jwt callback accepts only
 * with the server's proof (lib/auth/callbacks.ts strapiJwtUpdate), only for
 * the session's own user (strapiJwtUserId) and never for a session that
 * has already ended.
 */

/** The token fields the expiry decision reads (a subset of the Auth.js JWT). */
export type StrapiSessionToken = {
  strapiJwt?: unknown;
  strapiJwtExp?: unknown;
};

/** A Strapi JWT's payload, base64url-decoded WITHOUT verifying it; undefined when malformed. */
function strapiJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `exp` (epoch seconds) from a Strapi JWT's payload — base64url-decoded
 * WITHOUT verifying the signature. That is safe here because every JWT a
 * session records came straight from a cms answer to the web server
 * (/auth/local, the Entra exchange, or the change-password answer handed
 * over through a session update that carries the server's proof), never
 * from the browser; the recorded exp ends the web session no later than
 * that JWT ends, and Strapi verifies the signature on every request anyway.
 * undefined for anything malformed or without a numeric exp.
 */
export function strapiJwtExp(jwt: string): number | undefined {
  const exp = strapiJwtPayload(jwt)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
}

/**
 * The user id (`id`) from a Strapi JWT's payload, unverified like
 * strapiJwtExp(): the session update after a password change (FX40) takes a
 * JWT only with the server's proof and only when it names the session's own
 * user, so no session can be made to carry another user's token; Strapi
 * still verifies the signature on every request. undefined for anything
 * malformed or without a numeric id.
 */
export function strapiJwtUserId(jwt: string): number | undefined {
  const id = strapiJwtPayload(jwt)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Whether the Auth.js session carrying this token must end now.
 *  - No Strapi JWT at all: yes — a session that cannot talk to Strapi is
 *    useless and must not linger (fail closed).
 *  - Otherwise the recorded strapiJwtExp decides; tokens issued before
 *    D-SESSION-01 carry none, so the exp is decoded from the stored JWT.
 *  - No readable exp: no, `session.maxAge` (= the Strapi expiresIn) stays
 *    the upper bound. Strapi still rejects an expired JWT on every request.
 */
export function strapiSessionExpired(
  token: StrapiSessionToken,
  nowMs: number = Date.now(),
): boolean {
  if (typeof token.strapiJwt !== "string" || token.strapiJwt === "") return true;
  const exp =
    typeof token.strapiJwtExp === "number" ? token.strapiJwtExp : strapiJwtExp(token.strapiJwt);
  return exp !== undefined && nowMs >= exp * 1000;
}
