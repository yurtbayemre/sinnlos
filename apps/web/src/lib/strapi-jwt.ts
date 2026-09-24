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
 */

/** The token fields the expiry decision reads (a subset of the Auth.js JWT). */
export type StrapiSessionToken = {
  strapiJwt?: unknown;
  strapiJwtExp?: unknown;
};

/**
 * `exp` (epoch seconds) from a Strapi JWT's payload — base64url-decoded
 * WITHOUT verifying the signature. That is safe here: the value only ever
 * SHORTENS the web session, the JWT comes straight from Strapi's own
 * /auth/local or provider-callback response, and Strapi verifies the
 * signature on every request anyway. undefined for anything malformed or
 * without a numeric exp.
 */
export function strapiJwtExp(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload === null || typeof payload !== "object") return undefined;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
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
