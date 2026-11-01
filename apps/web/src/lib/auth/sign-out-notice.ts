/**
 * Sign-out ends every intranet session of the account (v0.34, A-02).
 *
 * Clearing this browser's cookie alone left a copied session cookie valid
 * for up to 7 days. signOutAction (lib/auth-actions.ts) therefore first asks
 * the cms to raise the account's token version (POST /api/me/sign-out),
 * which revokes every Strapi JWT issued before it: the sessions on the
 * other devices end too, as after a password change. Not the identity
 * provider's own session: Microsoft's end-session redirect stays as before,
 * a generic OIDC provider is not signed out.
 *
 * The call is bounded and never redirects (not strapi(), whose 401 sends
 * to /sign-in before the local cookie is cleared): whatever the cms
 * answers, this browser is signed out. When the cms did not confirm the
 * revocation (a timeout, a 5xx, the network, a 401 for a JWT it already
 * refuses), a short-lived notice cookie makes /sign-in say that the other
 * sessions may still be open. One notice, no retry: a lost answer may
 * follow a revocation that did happen. The cookie survives Microsoft's
 * end-session round trip (SameSite=Lax is sent on the top-level return),
 * so the registered post-logout URI stays /sign-in. It is consumed by
 * expiry only (a Server Component cannot delete a cookie); a confirmed
 * sign-out deletes a stale one.
 */

/** The notice cookie: host-only, for /sign-in only. */
export const SIGN_OUT_NOTICE_COOKIE = "sinnlos-sign-out-unconfirmed";
export const SIGN_OUT_NOTICE_PATH = "/sign-in";
/** Long enough for Microsoft's end-session page, short enough to be a flash. */
export const SIGN_OUT_NOTICE_TTL_S = 300;
/** How long the sign-out waits for the cms before it signs out locally anyway. */
export const SIGN_OUT_TIMEOUT_MS = 5_000;

/** The options the action sets the notice cookie with. */
export function signOutNoticeCookie(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: SIGN_OUT_NOTICE_PATH,
    maxAge: SIGN_OUT_NOTICE_TTL_S,
  };
}

/** Whether /sign-in shows the notice, from the request's cookie jar. */
export function signOutNoticeShown(jar: { get(name: string): { value: string } | undefined }) {
  return jar.get(SIGN_OUT_NOTICE_COOKIE)?.value === "1";
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Asks the cms to end every session of the JWT's account. True only when
 * it confirmed (2xx); never throws.
 */
export async function revokeAllSessions({
  strapiUrl,
  jwt,
  fetchImpl = fetch,
  timeoutMs = SIGN_OUT_TIMEOUT_MS,
}: {
  strapiUrl: string;
  jwt: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  try {
    const res = await fetchImpl(`${strapiUrl}/api/me/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return true;
    console.warn(`[auth] sign-out: the cms did not end the other sessions (${res.status})`);
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    console.warn(`[auth] sign-out: the cms did not end the other sessions (${name})`);
  }
  return false;
}
