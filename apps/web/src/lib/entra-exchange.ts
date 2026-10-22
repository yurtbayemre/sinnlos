/**
 * The web half of the identity-provider exchanges (D-ENTRA-01 spec C step
 * 3-5; OIDC since v0.25.0, deep-dive plan-oidc.md): the Auth.js signIn
 * callback (@/auth) POSTs the ID token of a completed sign-in to the cms,
 * which verifies it itself and answers with a Strapi JWT
 * (apps/cms/src/entra/provision.ts, apps/cms/src/oidc/provision.ts).
 *
 *   POST ${STRAPI_URL}/api/auth/entra/exchange
 *   x-entra-exchange-secret: <ENTRA_EXCHANGE_SECRET>
 *   { "idToken": "...", "accessToken": "..." }      (plus the Graph token)
 *
 *   POST ${STRAPI_URL}/api/auth/oidc/exchange
 *   x-oidc-exchange-secret: <OIDC_EXCHANGE_SECRET>
 *   { "idToken": "..." }
 *
 * 10 s per attempt; one retry after 500 ms, only on a network error or
 * timeout and on 502/503/504 (a cms restarting during a deploy, a JWKS or
 * Graph hiccup). Tokens travel in the POST body only, never in a URL, and
 * are never logged.
 */

export const EXCHANGE_PATH = "/api/auth/entra/exchange";
export const OIDC_EXCHANGE_PATH = "/api/auth/oidc/exchange";
export const EXCHANGE_TIMEOUT_MS = 10_000;
export const EXCHANGE_RETRY_DELAY_MS = 500;

/** The Entra error codes the sign-in page explains (`/sign-in?error=entra_<code>`). */
export const EXCHANGE_ERROR_CODES = [
  "account_exists",
  "not_assigned",
  "blocked",
  "invalid",
  "unavailable",
] as const;

/** The OIDC error codes (`/sign-in?error=oidc_<code>`): Entra's and an unverified e-mail address. */
export const OIDC_EXCHANGE_ERROR_CODES = [...EXCHANGE_ERROR_CODES, "email_unverified"] as const;

export type ExchangeErrorCode = (typeof OIDC_EXCHANGE_ERROR_CODES)[number];

/**
 * The `?error=` values of a refused Microsoft sign-in: `entra_tenant` (the
 * signIn callback's tenant check) and `entra_<code>` for every exchange
 * code. Also the message keys of the sign-in page (auth.entra_*).
 */
export const ENTRA_SIGN_IN_ERRORS = [
  "entra_tenant",
  ...EXCHANGE_ERROR_CODES.map((code) => `entra_${code}` as const),
] as const;

/** The `?error=` values (and auth.oidc_* message keys) of a refused OIDC sign-in. */
export const OIDC_SIGN_IN_ERRORS = OIDC_EXCHANGE_ERROR_CODES.map((code) => `oidc_${code}` as const);

export type SignInErrorKey =
  (typeof ENTRA_SIGN_IN_ERRORS)[number] | (typeof OIDC_SIGN_IN_ERRORS)[number];

const SIGN_IN_ERRORS: readonly string[] = [...ENTRA_SIGN_IN_ERRORS, ...OIDC_SIGN_IN_ERRORS];

/**
 * The sign-in page's message key for a `?error=` value: an entra_* or
 * oidc_* code gets its own text, any other value (Auth.js' AccessDenied,
 * Configuration, ...) the generic `signInFailed`, and no value none. The
 * parameter itself is never shown.
 */
export function signInErrorKey(
  error: string | string[] | undefined,
): SignInErrorKey | "signInFailed" | null {
  const value = Array.isArray(error) ? error[0] : error;
  if (!value) return null;
  return SIGN_IN_ERRORS.includes(value) ? (value as SignInErrorKey) : "signInFailed";
}

/** The cms's 200 body, as the jwt callback stores it on the session token. */
export interface ExchangeSuccess {
  jwt: string;
  /** exp of the jwt, epoch seconds: the Auth.js session ends then. */
  expiresAt: number;
  user: { id: number; displayName: string; email: string };
}

export type ExchangeResult =
  { ok: true; data: ExchangeSuccess } | { ok: false; code: ExchangeErrorCode };

export interface ExchangeOptions {
  strapiUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  log?: Pick<Console, "error" | "warn">;
}

/** One identity provider's exchange at the cms. */
interface ExchangeTarget {
  /** In log lines, e.g. "Entra". */
  label: string;
  path: string;
  secretHeader: string;
  /** The codes of the cms's refusals that reach the sign-in page. */
  codes: readonly ExchangeErrorCode[];
  /** For the operator hints of a 401 and a 404. */
  secretVariable: string;
  enabledVariable: string;
}

const ENTRA_TARGET: ExchangeTarget = {
  label: "Entra",
  path: EXCHANGE_PATH,
  secretHeader: "x-entra-exchange-secret",
  codes: EXCHANGE_ERROR_CODES,
  secretVariable: "ENTRA_EXCHANGE_SECRET",
  enabledVariable: "ENTRA_ENABLED",
};

const OIDC_TARGET: ExchangeTarget = {
  label: "OIDC",
  path: OIDC_EXCHANGE_PATH,
  secretHeader: "x-oidc-exchange-secret",
  codes: OIDC_EXCHANGE_ERROR_CODES,
  secretVariable: "OIDC_EXCHANGE_SECRET",
  enabledVariable: "OIDC_ENABLED",
};

const RETRY_STATUSES = new Set([502, 503, 504]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseSuccess(body: unknown): ExchangeSuccess | null {
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

type Attempt = { kind: "response"; response: Response } | { kind: "network"; reason: string };

async function exchangeSignIn(
  target: ExchangeTarget,
  body: Record<string, string>,
  options: ExchangeOptions,
): Promise<ExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console;
  const url = `${options.strapiUrl.replace(/\/$/, "")}${target.path}`;
  const attempt = async (): Promise<Attempt> => {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [target.secretHeader]: options.secret,
        },
        body: JSON.stringify(body),
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
  const retryable = (r: Attempt) => r.kind === "network" || RETRY_STATUSES.has(r.response.status);
  if (retryable(result)) {
    // Release the failed answer; never wait for it.
    if (result.kind === "response") void result.response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) =>
      setTimeout(resolve, options.retryDelayMs ?? EXCHANGE_RETRY_DELAY_MS),
    );
    result = await attempt();
  }

  if (result.kind === "network") {
    log.error(`[auth] ${target.label} exchange failed: the cms is unreachable (${result.reason})`);
    return { ok: false, code: "unavailable" };
  }
  const { response } = result;
  let answer: unknown = null;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (response.status === 200) {
    const data = parseSuccess(answer);
    if (data) return { ok: true, data };
    log.error(`[auth] ${target.label} exchange failed: the cms answered 200 without a usable body`);
    return { ok: false, code: "unavailable" };
  }
  const code = isRecord(answer) ? answer.error : undefined;
  if (
    typeof code === "string" &&
    (target.codes as readonly string[]).includes(code) &&
    code !== "unavailable"
  ) {
    log.warn(`[auth] ${target.label} sign-in refused by the cms: ${response.status} ${code}`);
    return { ok: false, code: code as ExchangeErrorCode };
  }
  // 401 unauthorized (the exchange secrets differ), 404 (the provider off in
  // the cms), a 5xx after the retry: an operator problem, never the user's.
  log.error(
    `[auth] ${target.label} exchange failed: ${response.status} ${typeof code === "string" ? code : "(no error code)"}` +
      (response.status === 401 && code === "unauthorized"
        ? ` — ${target.secretVariable} differs between web and cms`
        : response.status === 404
          ? ` — is ${target.enabledVariable}=1 set for the cms too?`
          : ""),
  );
  return { ok: false, code: "unavailable" };
}

/** A Microsoft sign-in: the ID token and the Graph access token. */
export function exchangeEntraSignIn(
  tokens: { idToken: string; accessToken: string },
  options: ExchangeOptions,
): Promise<ExchangeResult> {
  return exchangeSignIn(
    ENTRA_TARGET,
    { idToken: tokens.idToken, accessToken: tokens.accessToken },
    options,
  );
}

/** An OIDC sign-in (Keycloak, authentik, Zitadel): the ID token only. */
export function exchangeOidcSignIn(
  tokens: { idToken: string },
  options: ExchangeOptions,
): Promise<ExchangeResult> {
  return exchangeSignIn(OIDC_TARGET, { idToken: tokens.idToken }, options);
}
