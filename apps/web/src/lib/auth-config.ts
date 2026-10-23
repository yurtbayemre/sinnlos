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
 *    AUTH_LOCAL_ENABLED=1, and automatically whenever no identity provider
 *    is on (ENTRA_ENABLED and OIDC_ENABLED not '1'), so a fresh clone signs
 *    in with zero auth config (localSignInEnabled, plan-oidc.md C1). The cms
 *    mirrors the same rule (utils/sign-in-policy.ts) into users-permissions'
 *    grant.email.
 *  - OIDC (Keycloak, authentik, Zitadel; v0.25.0, deep-dive plan-oidc.md):
 *    on only with OIDC_ENABLED=1, validated the same way (parseOidcWebConfig,
 *    an invalid one throws on first import outside `next build`). Never
 *    together with ENTRA_ENABLED=1: one identity provider per install. The
 *    cms validates its own half (apps/cms/src/oidc/config.ts).
 *  - No self-registration (removed in v0.27): admins invite at /manage/users.
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
        .join(
          "; ",
        )}. Fix the web env (docs/DEPLOYMENT.md, "Microsoft Entra ID sign-in"), or unset ENTRA_ENABLED.`,
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
 * `postLogoutRedirect`. Microsoft only redirects there when it is one of the
 * app registration's (Web) redirect URIs, so `${WEB_PUBLIC_URL}/sign-in` is
 * registered as a second redirect URI. Not as the front-channel logout URL:
 * that is Microsoft's single sign-out call, which this app does not use.
 */
export function entraLogoutUrl(tenantId: string, postLogoutRedirect: string): string {
  const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect);
  return url.toString();
}

/** The OIDC half of the web's configuration (OIDC_ENABLED=1). */
export interface OidcWebConfig {
  /** As configured: exactly what the IdP's discovery document says (Auth.js compares it). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Shared with the cms, sent as x-oidc-exchange-secret. */
  exchangeSecret: string;
  /** OIDC_SCOPE plus, with OIDC_ZITADEL_ORG_ID, Zitadel's organisation scopes. */
  scope: string;
  /** The sign-in button's label. */
  displayName: string;
  /** OIDC_ALLOW_HTTP=1: http issuer and endpoints (development and staging only). */
  allowHttp: boolean;
}

export const OIDC_DEFAULT_SCOPE = "openid profile email";
export const OIDC_DEFAULT_DISPLAY_NAME = "Single Sign-On";

/** OIDC_ENABLED=1 with an invalid configuration. */
export class OidcWebConfigError extends Error {
  readonly variables: readonly string[];

  constructor(problems: readonly { variable: string; message: string }[]) {
    super(
      `[auth] OIDC_ENABLED=1, but the OIDC configuration is invalid: ${problems
        .map(({ variable, message }) => `${variable} ${message}`)
        .join("; ")}. Fix the web env (docs/DEPLOYMENT.md, "OIDC sign-in"), or unset OIDC_ENABLED.`,
    );
    this.name = "OidcWebConfigError";
    this.variables = problems.map(({ variable }) => variable);
  }
}

const urlProtocol = (value: string): string => {
  try {
    return new URL(value).protocol;
  } catch {
    return "";
  }
};

/**
 * The OIDC configuration for this env: null while OIDC_ENABLED is not '1';
 * throws OidcWebConfigError when it is and anything is invalid. Values are
 * never echoed (secrets).
 */
export function parseOidcWebConfig(env: Env): OidcWebConfig | null {
  if (env.OIDC_ENABLED !== "1") return null;
  const problems: { variable: string; message: string }[] = [];
  const problem = (variable: string, message: string) => problems.push({ variable, message });
  if (env.ENTRA_ENABLED === "1") {
    problem(
      "ENTRA_ENABLED",
      "must not be 1 next to OIDC_ENABLED=1 (one identity provider per install)",
    );
  }
  // Trimmed only: a trailing slash belongs to the issuer (authentik's has one).
  const issuer = (env.OIDC_ISSUER ?? "").trim();
  const protocol = urlProtocol(issuer);
  const httpAllowed = env.OIDC_ALLOW_HTTP === "1";
  if (
    issuer.length > 255 ||
    /\s/.test(issuer) ||
    !(protocol === "https:" || (protocol === "http:" && httpAllowed))
  ) {
    problem(
      "OIDC_ISSUER",
      "must be the issuer URL exactly as the IdP's discovery document writes it, https (http only with OIDC_ALLOW_HTTP=1), at most 255 characters",
    );
  }
  const clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  if (clientId === "" || clientId.length > 255) {
    problem("OIDC_CLIENT_ID", "must be set (at most 255 characters)");
  }
  const clientSecret = env.OIDC_CLIENT_SECRET ?? "";
  if (clientSecret.trim() === "") problem("OIDC_CLIENT_SECRET", "must be set");
  const exchangeSecret = env.OIDC_EXCHANGE_SECRET ?? "";
  if (exchangeSecret.trim().length < EXCHANGE_SECRET_MIN_LENGTH) {
    problem(
      "OIDC_EXCHANGE_SECRET",
      `must have at least ${EXCHANGE_SECRET_MIN_LENGTH} characters (openssl rand -hex 32, same value for cms and web)`,
    );
  }
  let scope = (env.OIDC_SCOPE ?? "").trim() || OIDC_DEFAULT_SCOPE;
  if (!scope.split(/\s+/).includes("openid")) problem("OIDC_SCOPE", "must contain openid");
  const displayName = (env.OIDC_DISPLAY_NAME ?? "").trim() || OIDC_DEFAULT_DISPLAY_NAME;
  if (displayName.length > 40) problem("OIDC_DISPLAY_NAME", "must have at most 40 characters");
  const zitadelOrgId = (env.OIDC_ZITADEL_ORG_ID ?? "").trim();
  if (zitadelOrgId !== "") {
    if (/^\d+$/.test(zitadelOrgId)) {
      // Zitadel then signs in members of this organisation only; the cms checks it again.
      scope += ` urn:zitadel:iam:org:id:${zitadelOrgId} urn:zitadel:iam:user:resourceowner`;
    } else {
      problem("OIDC_ZITADEL_ORG_ID", "must be the Zitadel organisation id (digits only)");
    }
  }
  if (problems.length > 0) throw new OidcWebConfigError(problems);
  return {
    issuer,
    clientId,
    clientSecret,
    exchangeSecret,
    scope,
    displayName,
    allowHttp: httpAllowed,
  };
}

function loadOrNullDuringBuild<T>(parse: (env: Env) => T | null, env: Env): T | null {
  try {
    return parse(env);
  } catch (err) {
    // `next build` imports this without any runtime env: never fail there.
    if (env.NEXT_PHASE === "phase-production-build") return null;
    throw err;
  }
}

/** The Entra configuration, or null while Microsoft sign-in is off. */
export const ENTRA: EntraWebConfig | null = loadOrNullDuringBuild(parseEntraWebConfig, process.env);

/** The OIDC configuration, or null while OIDC sign-in is off. */
export const OIDC: OidcWebConfig | null = loadOrNullDuringBuild(parseOidcWebConfig, process.env);

export const MICROSOFT_ENABLED = ENTRA !== null;

/**
 * Local sign-in: AUTH_LOCAL_ENABLED=1 next to an identity provider
 * (break-glass), or no identity provider on at all. The cms's
 * utils/sign-in-policy.ts has the same rule.
 */
export function localSignInEnabled(env: Env): boolean {
  return env.AUTH_LOCAL_ENABLED === "1" || (env.ENTRA_ENABLED !== "1" && env.OIDC_ENABLED !== "1");
}

export const LOCAL_ENABLED = localSignInEnabled(process.env);
