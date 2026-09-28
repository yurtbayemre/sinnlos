/**
 * The web half of the Entra exchange (D-ENTRA-01 spec C step 3-5): the
 * Auth.js signIn callback (@/auth) POSTs the ID token and the Graph access
 * token of a completed Microsoft sign-in to the cms, which verifies the ID
 * token itself and answers with a Strapi JWT
 * (apps/cms/src/entra/provision.ts).
 *
 *   POST ${STRAPI_URL}/api/auth/entra/exchange
 *   x-entra-exchange-secret: <ENTRA_EXCHANGE_SECRET>
 *   { "idToken": "...", "accessToken": "..." }
 *
 * 10 s per attempt; one retry after 500 ms, only on a network error or
 * timeout and on 502/503/504 (a cms restarting during a deploy, a JWKS or
 * Graph hiccup). Tokens travel in the POST body only, never in a URL, and
 * are never logged.
 */

export const EXCHANGE_PATH = "/api/auth/entra/exchange";
export const EXCHANGE_TIMEOUT_MS = 10_000;
export const EXCHANGE_RETRY_DELAY_MS = 500;

/** The error codes the sign-in page explains (`/sign-in?error=entra_<code>`). */
export const EXCHANGE_ERROR_CODES = [
  "account_exists",
  "not_assigned",
  "blocked",
  "invalid",
  "unavailable",
] as const;

export type ExchangeErrorCode = (typeof EXCHANGE_ERROR_CODES)[number];

/**
 * The `?error=` values of a refused Microsoft sign-in: `entra_tenant` (the
 * signIn callback's tenant check) and `entra_<code>` for every exchange
 * code. Also the message keys of the sign-in page (auth.entra_*).
 */
export const ENTRA_SIGN_IN_ERRORS = [
  "entra_tenant",
  ...EXCHANGE_ERROR_CODES.map((code) => `entra_${code}` as const),
] as const;

export type EntraSignInError = (typeof ENTRA_SIGN_IN_ERRORS)[number];

/**
 * The sign-in page's message key for a `?error=` value: an entra_* code
 * gets its own text, any other value (Auth.js' AccessDenied,
 * Configuration, ...) the generic `signInFailed`, and no value none. The
 * parameter itself is never shown.
 */
export function signInErrorKey(
  error: string | string[] | undefined,
): EntraSignInError | "signInFailed" | null {
  const value = Array.isArray(error) ? error[0] : error;
  if (!value) return null;
  return (ENTRA_SIGN_IN_ERRORS as readonly string[]).includes(value)
    ? (value as EntraSignInError)
    : "signInFailed";
}

/** The cms's 200 body, as the jwt callback stores it on the session token. */
export interface EntraExchangeSuccess {
  jwt: string;
  /** exp of the jwt, epoch seconds: the Auth.js session ends then. */
  expiresAt: number;
  user: { id: number; displayName: string; email: string };
}

export type EntraExchangeResult =
  | { ok: true; data: EntraExchangeSuccess }
  | { ok: false; code: ExchangeErrorCode };

export interface ExchangeOptions {
  strapiUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  log?: Pick<Console, "error" | "warn">;
}

const RETRY_STATUSES = new Set([502, 503, 504]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseSuccess(body: unknown): EntraExchangeSuccess | null {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  const { jwt, expiresAt, user } = body;
  if (typeof jwt !== "string" || jwt === "" || typeof expiresAt !== "number") return null;
  if (typeof user.id !== "number") return null;
  return {
    jwt,
    expiresAt,
    user: {
      id: user.id,
      displayName: typeof user.displayName === "string" ? user.displayName : "",
      email: typeof user.email === "string" ? user.email : "",
    },
  };
}

const isKnownCode = (value: unknown): value is ExchangeErrorCode =>
  typeof value === "string" && (EXCHANGE_ERROR_CODES as readonly string[]).includes(value);

type Attempt = { kind: "response"; response: Response } | { kind: "network"; reason: string };

export async function exchangeEntraSignIn(
  tokens: { idToken: string; accessToken: string },
  options: ExchangeOptions,
): Promise<EntraExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console;
  const url = `${options.strapiUrl.replace(/\/$/, "")}${EXCHANGE_PATH}`;
  const attempt = async (): Promise<Attempt> => {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-entra-exchange-secret": options.secret,
        },
        body: JSON.stringify({ idToken: tokens.idToken, accessToken: tokens.accessToken }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? EXCHANGE_TIMEOUT_MS),
      });
      return { kind: "response", response };
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      return { kind: "network", reason: name === "TimeoutError" ? "timeout" : name };
    }
  };

  let result = await attempt();
  const retryable = (r: Attempt) =>
    r.kind === "network" || RETRY_STATUSES.has(r.response.status);
  if (retryable(result)) {
    // Release the failed answer; never wait for it.
    if (result.kind === "response") void result.response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? EXCHANGE_RETRY_DELAY_MS));
    result = await attempt();
  }

  if (result.kind === "network") {
    log.error(`[auth] Entra exchange failed: the cms is unreachable (${result.reason})`);
    return { ok: false, code: "unavailable" };
  }
  const { response } = result;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 200) {
    const data = parseSuccess(body);
    if (data) return { ok: true, data };
    log.error("[auth] Entra exchange failed: the cms answered 200 without a usable body");
    return { ok: false, code: "unavailable" };
  }
  const code = isRecord(body) ? body.error : undefined;
  if (isKnownCode(code) && code !== "unavailable") {
    log.warn(`[auth] Entra sign-in refused by the cms: ${response.status} ${code}`);
    return { ok: false, code };
  }
  // 401 unauthorized (the exchange secrets differ), 404 (Entra off in the
  // cms), a 5xx after the retry: an operator problem, never the user's.
  log.error(
    `[auth] Entra exchange failed: ${response.status} ${typeof code === "string" ? code : "(no error code)"}` +
      (response.status === 401 && code === "unauthorized"
        ? " — ENTRA_EXCHANGE_SECRET differs between web and cms"
        : response.status === 404
          ? " — is ENTRA_ENABLED=1 set for the cms too?"
          : ""),
  );
  return { ok: false, code: "unavailable" };
}
