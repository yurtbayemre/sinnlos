/**
 * Which sign-in methods are active, derived from env (D-ENTRA-01 spec A,
 * deep-dive decisions/01-microsoft-signin.md):
 *  - Microsoft Entra ID: on only with ENTRA_ENABLED=1. Anything else means
 *    off, and every AUTH_MICROSOFT_ENTRA_ID_* value is ignored (an old
 *    infra/.env may still hold placeholders). With ENTRA_ENABLED=1 the
 *    configuration is validated, and an invalid one throws on first import
 *    (outside `next build`), naming each bad variable: every request then
 *    fails instead of silently falling back to local sign-in on an
 *    Entra-only install. The cms validates its own half
 *    (apps/cms/src/entra/config.ts); infra/deploy.sh --check both.
 *  - Local (email+password against Strapi /api/auth/local): on with
 *    AUTH_LOCAL_ENABLED=1, and automatically whenever ENTRA_ENABLED is not
 *    '1', so a fresh clone signs in with zero auth config. The cms mirrors
 *    the same rule into users-permissions' grant.email.
 *  - Registration form: LOCAL_REGISTRATION=1 (must match the CMS env).
 */

type Env = Record<string, string | undefined>;

/** A GUID in 8-4-4-4-12 hex form, either case (used lower-cased). */
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ENTRA_EXCHANGE_SECRET: at least this many characters (same rule as the cms). */
export const EXCHANGE_SECRET_MIN_LENGTH = 32;

/** The Entra half of the web's configuration. */
export interface EntraWebConfig {
  /** Lower-cased tenant GUID (AUTH_MICROSOFT_ENTRA_ID_TENANT_ID). */
  tenantId: string;
  /** Lower-cased app (client) id GUID (AUTH_MICROSOFT_ENTRA_ID_ID). */
  clientId: string;
  clientSecret: string;
  /** Shared with the cms, sent as x-entra-exchange-secret. */
  exchangeSecret: string;
  /** ENTRA_SYNC_MANAGER=1: the cms reads /me/manager, which needs User.Read.All. */
  syncManager: boolean;
  /** https://login.microsoftonline.com/<tenant>/v2.0 */
  issuer: string;
  /** No offline_access: no refresh token is ever requested or stored. */
  scope: string;
}

/** ENTRA_ENABLED=1 with an invalid configuration. */
export class EntraWebConfigError extends Error {
  readonly variables: readonly string[];

  constructor(problems: readonly { variable: string; message: string }[]) {
    super(
      `[auth] ENTRA_ENABLED=1, but the Entra configuration is invalid: ${problems
        .map(({ variable, message }) => `${variable} ${message}`)
        .join("; ")}. Fix the web env (docs/DEPLOYMENT.md, "Microsoft Entra ID sign-in"), or unset ENTRA_ENABLED.`,
    );
    this.name = "EntraWebConfigError";
    this.variables = problems.map(({ variable }) => variable);
  }
}

/**
 * The Entra configuration for this env: null while ENTRA_ENABLED is not
 * '1'; throws EntraWebConfigError when it is and anything is invalid.
 * Values are never echoed (secrets).
 */
export function parseEntraWebConfig(env: Env): EntraWebConfig | null {
  if (env.ENTRA_ENABLED !== "1") return null;
  const problems: { variable: string; message: string }[] = [];
  const tenantId = (env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID ?? "").trim().toLowerCase();
  if (!GUID_PATTERN.test(tenantId)) {
    problems.push({
      variable: "AUTH_MICROSOFT_ENTRA_ID_TENANT_ID",
      message:
        "must be the tenant GUID (common, organizations, consumers and domain names are refused; compose fills it from MS_TENANT_ID)",
    });
  }
  const clientId = (env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "").trim().toLowerCase();
  if (!GUID_PATTERN.test(clientId)) {
    problems.push({
      variable: "AUTH_MICROSOFT_ENTRA_ID_ID",
      message: "must be the app (client) id GUID (compose fills it from MS_CLIENT_ID)",
    });
  }
  const clientSecret = env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "";
  if (clientSecret.trim() === "") {
    problems.push({
      variable: "AUTH_MICROSOFT_ENTRA_ID_SECRET",
      message: "must be set (compose fills it from MS_CLIENT_SECRET)",
    });
  }
  const exchangeSecret = env.ENTRA_EXCHANGE_SECRET ?? "";
  if (exchangeSecret.trim().length < EXCHANGE_SECRET_MIN_LENGTH) {
    problems.push({
      variable: "ENTRA_EXCHANGE_SECRET",
      message: `must have at least ${EXCHANGE_SECRET_MIN_LENGTH} characters (openssl rand -hex 32, same value for cms and web)`,
    });
  }
  if (problems.length > 0) throw new EntraWebConfigError(problems);
  const syncManager = env.ENTRA_SYNC_MANAGER === "1";
  return {
    tenantId,
    clientId,
    clientSecret,
    exchangeSecret,
    syncManager,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    scope: `openid profile email User.Read${syncManager ? " User.Read.All" : ""}`,
  };
}

/**
 * Microsoft's end-session URL for the tenant, returning the browser to
 * `postLogoutRedirect` (register it as the app's front-channel logout URL).
 */
export function entraLogoutUrl(tenantId: string, postLogoutRedirect: string): string {
  const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect);
  return url.toString();
}

function loadEntra(env: Env): EntraWebConfig | null {
  try {
    return parseEntraWebConfig(env);
  } catch (err) {
    // `next build` imports this without any runtime env: never fail there.
    if (env.NEXT_PHASE === "phase-production-build") return null;
    throw err;
  }
}

/** The Entra configuration, or null while Microsoft sign-in is off. */
export const ENTRA: EntraWebConfig | null = loadEntra(process.env);

export const MICROSOFT_ENABLED = ENTRA !== null;

export const LOCAL_ENABLED =
  process.env.AUTH_LOCAL_ENABLED === "1" || process.env.ENTRA_ENABLED !== "1";

export const REGISTRATION_ENABLED = LOCAL_ENABLED && process.env.LOCAL_REGISTRATION === "1";
