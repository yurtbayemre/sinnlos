/**
 * Distinct sign-in failure for Strapi's own auth throttle (FX11).
 *
 * authorize() in @/auth throws this when POST /api/auth/local answers 429,
 * instead of returning null (which Auth.js reports as the generic
 * CredentialsSignin — "Invalid email or password"). Auth.js rethrows
 * CredentialsSignin subclasses from a Server Action's signIn()
 * (@auth/core index.js: raw + AuthError) and puts `code` into the error
 * redirect of the raw POST /api/auth/callback/local route
 * (`?error=CredentialsSignin&code=rate_limited`). The code is URL-visible
 * and hints at nothing about the account.
 */
import { CredentialsSignin } from "next-auth";

export const RATE_LIMITED_SIGN_IN_CODE = "rate_limited";

export class StrapiRateLimitedSignIn extends CredentialsSignin {
  code = RATE_LIMITED_SIGN_IN_CODE;
}

/** Whether a signIn() rejection is the Strapi-throttle case above. */
export function isRateLimitedSignIn(error: unknown): boolean {
  return error instanceof CredentialsSignin && error.code === RATE_LIMITED_SIGN_IN_CODE;
}
