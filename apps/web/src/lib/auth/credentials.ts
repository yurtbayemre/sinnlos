/**
 * The local sign-in's verification (WD09): what the Credentials provider's
 * authorize() does, as one function over injected dependencies (fetch, the
 * login limiter, the clock, the log), so it is unit tested without Auth.js
 * (credentials.test.ts). auth.ts wires the real ones.
 *
 * Both entry points land here — the sign-in Server Action (signIn("local"))
 * AND a raw POST /api/auth/callback/local — so the limiter here is the
 * authoritative gate of issue #23; a limiter on either outer path alone
 * would be bypassable.
 *
 * Counting rule: only genuine verification failures count. Strapi answers
 * bad credentials with 400 (any other 4xx counts the same). 5xx and 429 mean
 * Strapi/DB trouble or Strapi's own throttle, not a wrong password, and a
 * network error or timeout is no verdict at all: counting those would keep
 * legitimate users locked out for up to 15 minutes after an outage.
 *
 * Strapi's throttle (429) throws StrapiRateLimitedSignIn so the form says
 * "too many attempts" instead of "invalid email or password" (FX11).
 *
 * The email of the session comes from the /api/auth/local payload, never
 * from /api/users/me: the latter runs through the content-api sanitizer
 * (issue #10), which strips email for non-privileged roles. Display name
 * and id come from /api/users/me; when that read fails, the payload's user
 * stands in (the password was right, the read is only for the display
 * name). Role and department are NOT taken here (D-SESSION-01): getViewer()
 * reads them per request.
 */
import type { User } from "next-auth";
import { StrapiRateLimitedSignIn } from "@/lib/auth-errors";
import { maskIdentifier, type LoginRateLimiter } from "@/lib/login-rate-limit";

/** Timeout of each Strapi request of a sign-in. */
export const LOCAL_SIGN_IN_TIMEOUT_MS = 5_000;

export interface CredentialsDeps {
  /** Internal Strapi URL (STRAPI_URL). */
  strapiUrl: string;
  fetch: typeof fetch;
  limiter: LoginRateLimiter;
  /** Epoch milliseconds: the limiter's clock. */
  now: () => number;
  /** The security log of a block transition (console.warn in production). */
  warn: (message: string) => void;
  timeoutMs?: number;
}

export interface CredentialsInput {
  /** The form fields as Auth.js hands them over (untrusted). */
  identifier: unknown;
  password: unknown;
  /** The client IP (lib/login-rate-limit.ts clientIpFrom). */
  clientIp: string;
}

/** The identity fields of Strapi's user answers the sign-in reads. */
interface StrapiUserFields {
  id: number;
  email?: unknown;
  username?: unknown;
  displayName?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** A Strapi user object with a numeric id, else null. */
function userFields(value: unknown): StrapiUserFields | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  return {
    id: value.id,
    email: value.email,
    username: value.username,
    displayName: value.displayName,
  };
}

/** Whether a refused /api/auth/local answer counts against the limiter. */
export function countsAsFailure(status: number): boolean {
  return status < 500 && status !== 429;
}

/**
 * Verifies `input` against Strapi's /api/auth/local. Resolves the Auth.js
 * user (with the Strapi JWT, server-side only) or null; throws
 * StrapiRateLimitedSignIn on Strapi's 429.
 */
export async function authorizeCredentials(
  input: CredentialsInput,
  deps: CredentialsDeps,
): Promise<User | null> {
  const identifier = typeof input.identifier === "string" ? input.identifier : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!identifier || !password) return null;
  const { clientIp } = input;
  const timeoutMs = deps.timeoutMs ?? LOCAL_SIGN_IN_TIMEOUT_MS;

  // Rate-limit BEFORE touching Strapi. No log for a blocked attempt: the
  // transition INTO the block state is logged once below — logging every
  // rejected follow-up would let a script generate ~100 log lines/s through
  // the /api/auth callback (the edge limit is 100/s).
  if (deps.limiter.isBlocked(clientIp, identifier, deps.now())) return null;

  let res: Response;
  try {
    res = await deps.fetch(`${deps.strapiUrl}/api/auth/local`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forward the real client IP: Strapi's users-permissions throttle
        // keys /auth/local on ctx.request.ip, which honours this header only
        // since server.proxy.koa (FX11). Without it every user shares the
        // web container's IP as ONE bucket — 10 requests/min would lock
        // everyone out.
        "X-Forwarded-For": clientIp,
      },
      body: JSON.stringify({ identifier, password }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network error or timeout: no verdict, nothing counted.
    return null;
  }

  if (!res.ok) {
    if (countsAsFailure(res.status)) {
      const justBlocked = deps.limiter.recordFailure(clientIp, identifier, deps.now());
      if (justBlocked) {
        // Logged once per lock window, at the transition. The full IP is
        // intentional: this is a security log of an attack pattern
        // (legitimate interest) and the IP is what an admin needs to
        // correlate with edge logs or block upstream.
        deps.warn(
          `[login-rate-limit] block engaged ip=${clientIp} identifier=${maskIdentifier(identifier)}`,
        );
      }
    }
    if (res.status === 429) throw new StrapiRateLimitedSignIn();
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }
  const jwt = isRecord(payload) ? text(payload.jwt) : undefined;
  const signedIn = isRecord(payload) ? userFields(payload.user) : null;
  if (!jwt || !signedIn) return null;
  deps.limiter.recordSuccess(identifier);

  // Display name and id of the fresh user; the payload's user stands in
  // when this read fails.
  let me: StrapiUserFields | null = null;
  try {
    const meRes = await deps.fetch(`${deps.strapiUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (meRes.ok) me = userFields(await meRes.json());
  } catch {
    me = null;
  }
  const profile = me ?? signedIn;
  return {
    id: String(profile.id),
    name: text(profile.displayName) ?? text(profile.username) ?? null,
    // From the /api/auth/local payload (not sanitized), see the header.
    // Session identity is the id/JWT, never the email (F4).
    email: text(signedIn.email) ?? text(me?.email) ?? null,
    strapiJwt: jwt,
    strapiUserId: profile.id,
  };
}
