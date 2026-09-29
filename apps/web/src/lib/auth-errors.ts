/**
 * Distinct sign-in failures for a throttled attempt: Strapi's own auth
 * throttle (FX11) and the web's login limiter (issue #23, FX39).
 *
 * authorize() in @/auth (lib/auth/credentials.ts) throws one of these
 * instead of returning null (which Auth.js reports as the generic
 * CredentialsSignin — "Invalid email or password"). Auth.js rethrows
 * CredentialsSignin subclasses from a Server Action's signIn()
 * (@auth/core index.js: raw + AuthError) and puts `code` into the error
 * redirect of the raw POST /api/auth/callback/local route
 * (`?error=CredentialsSignin&code=rate_limited`). Both share the one code:
 * the form says "too many attempts" either way. The code is URL-visible and
 * hints at nothing about the account (a per-identifier block follows ten
 * failures, whether or not the account exists).
 */
import { CredentialsSignin } from "next-auth";

export const RATE_LIMITED_SIGN_IN_CODE = "rate_limited";

/** POST /api/auth/local answered 429 (Strapi's throttle). */
export class StrapiRateLimitedSignIn extends CredentialsSignin {
  code = RATE_LIMITED_SIGN_IN_CODE;
}

/**
 * The web's login limiter refused the attempt (tryAcquire → "blocked"),
 * before any request to Strapi. Also reached when the sign-in action's
 * read-only pre-check still passed but parallel attempts took the last
 * places in between.
 */
export class LoginBlockedSignIn extends CredentialsSignin {
  code = RATE_LIMITED_SIGN_IN_CODE;
}

/** Whether a signIn() rejection is one of the throttled cases above. */
export function isRateLimitedSignIn(error: unknown): boolean {
  return error instanceof CredentialsSignin && error.code === RATE_LIMITED_SIGN_IN_CODE;
}
