/**
 * Generic OIDC sign-in (Keycloak, authentik, Zitadel; v0.25.0, deep-dive
 * plan-oidc.md "v0.25.0 build contract"), enablement and validation. Pure:
 * env in, settings out. The Entra model (entra/config.ts) throughout:
 *
 * OIDC_ENABLED is the only switch. Anything but '1' means disabled: the
 * exchange route answers 404, no discovery or key request is ever made, and
 * every other OIDC_* value is ignored. With OIDC_ENABLED=1 the whole
 * configuration is validated, and an invalid one throws an OidcConfigError
 * that names every bad variable: register() (src/index.ts) lets it fail the
 * boot. One identity provider per install: ENTRA_ENABLED=1 next to it is
 * refused. Values are never echoed (the exchange secret).
 *
 * infra/deploy.sh repeats these rules in its preflight; the web's
 * lib/auth-config.ts validates its own half (client secret, scope, button
 * label).
 */
import {
  DEFAULT_SESSION_TTL,
  ENTRA_DEFAULT_ROLES,
  EXCHANGE_SECRET_MIN_LENGTH,
  parseSessionTtl,
  type EntraDefaultRole,
} from "../entra/config";
import { isPlaceholderSecret } from "../utils/env-guard";
import { localSignInEnabled } from "../utils/sign-in-policy";

type Env = Record<string, string | undefined>;

/** The identity columns are varchar(255): a longer issuer or subject cannot be stored. */
export const MAX_IDENTITY_LENGTH = 255;

/** OIDC_ROLES_CLAIM and OIDC_DEPARTMENT_CLAIM: dot-separated claim names. */
const CLAIM_PATH = /^[A-Za-z0-9_:/-]+(\.[A-Za-z0-9_:/-]+)*$/;

/** Zitadel organisation ids are numeric strings. */
const ZITADEL_ORG_ID = /^\d+$/;

/** Claims under this name carry base64url-encoded values (Zitadel user metadata). */
export const ZITADEL_METADATA_CLAIM = "urn:zitadel:iam:user:metadata";

export interface OidcConfig {
  enabled: true;
  /** As configured; the exchange compares it with the discovery document's issuer. */
  issuer: string;
  clientId: string;
  /** Shared with the web; compared in constant time, never logged. */
  exchangeSecret: string;
  /** OIDC_ROLES_CLAIM split at the dots. */
  rolesClaim: readonly string[];
  /** OIDC_DEPARTMENT_CLAIM split at the dots; null: no department sync. */
  departmentClaim: readonly string[] | null;
  zitadelOrgId: string | null;
  defaultRole: EntraDefaultRole;
  sessionTtl: string;
  sessionTtlSeconds: number;
  /** OIDC_ALLOW_HTTP=1: http issuer and endpoints (development and staging only). */
  allowHttp: boolean;
  localEnabled: boolean;
  localRegistration: boolean;
}

export type OidcSettings = OidcConfig | { enabled: false };

export interface OidcConfigIssue {
  variable: string;
  message: string;
}

/** OIDC_ENABLED=1 with an invalid configuration; names every bad variable. */
export class OidcConfigError extends Error {
  readonly issues: readonly OidcConfigIssue[];

  constructor(issues: readonly OidcConfigIssue[]) {
    super(
      `[oidc] OIDC_ENABLED=1, but the OIDC configuration is invalid: ${issues
        .map(({ variable, message }) => `${variable} ${message}`)
        .join(
          "; ",
        )}. Fix infra/.env (docs/SSO.md, "OIDC sign-in (Keycloak, authentik, Zitadel)"), or unset OIDC_ENABLED.`,
    );
    this.name = "OidcConfigError";
    this.issues = issues;
  }
}

const trimmed = (value: string | undefined) => (value ?? "").trim();

/** Whether `value` is an absolute http(s) URL the exchange may fetch from. */
export function isAllowedUrl(value: string, allowHttp: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (allowHttp && url.protocol === "http:");
}

/** The settings for this env. Throws OidcConfigError only when OIDC_ENABLED=1 and it is invalid. */
export function parseOidcConfig(env: Env = process.env): OidcSettings {
  if (env.OIDC_ENABLED !== "1") return { enabled: false };

  const issues: OidcConfigIssue[] = [];
  const issue = (variable: string, message: string) => issues.push({ variable, message });

  if (env.ENTRA_ENABLED === "1") {
    issue(
      "ENTRA_ENABLED",
      "must not be 1 next to OIDC_ENABLED=1 (one identity provider per install)",
    );
  }
  const allowHttp = env.OIDC_ALLOW_HTTP === "1";
  const issuer = trimmed(env.OIDC_ISSUER);
  if (
    !isAllowedUrl(issuer, allowHttp) ||
    /\s/.test(issuer) ||
    issuer.length > MAX_IDENTITY_LENGTH
  ) {
    issue(
      "OIDC_ISSUER",
      `must be the issuer URL exactly as the identity provider's discovery document writes it, https (http only with OIDC_ALLOW_HTTP=1), at most ${MAX_IDENTITY_LENGTH} characters`,
    );
  }
  const clientId = trimmed(env.OIDC_CLIENT_ID);
  if (clientId === "" || clientId.length > MAX_IDENTITY_LENGTH) {
    issue("OIDC_CLIENT_ID", `must be set (at most ${MAX_IDENTITY_LENGTH} characters)`);
  }
  const exchangeSecret = env.OIDC_EXCHANGE_SECRET ?? "";
  if (exchangeSecret.trim().length < EXCHANGE_SECRET_MIN_LENGTH) {
    issue(
      "OIDC_EXCHANGE_SECRET",
      `must have at least ${EXCHANGE_SECRET_MIN_LENGTH} characters (openssl rand -hex 32)`,
    );
  } else if (isPlaceholderSecret(exchangeSecret)) {
    issue("OIDC_EXCHANGE_SECRET", "holds a template placeholder (openssl rand -hex 32)");
  }

  const rolesClaim = trimmed(env.OIDC_ROLES_CLAIM) || "roles";
  if (!CLAIM_PATH.test(rolesClaim)) {
    issue(
      "OIDC_ROLES_CLAIM",
      "must be a claim name or a dot-separated path, e.g. roles or resource_access.sinnlos.roles",
    );
  }
  const departmentClaim = trimmed(env.OIDC_DEPARTMENT_CLAIM);
  if (departmentClaim !== "" && !CLAIM_PATH.test(departmentClaim)) {
    issue("OIDC_DEPARTMENT_CLAIM", "must be a claim name or a dot-separated path");
  }
  const zitadelOrgId = trimmed(env.OIDC_ZITADEL_ORG_ID);
  if (zitadelOrgId !== "" && !ZITADEL_ORG_ID.test(zitadelOrgId)) {
    issue("OIDC_ZITADEL_ORG_ID", "must be the Zitadel organisation id (digits)");
  }
  if (rolesClaim.startsWith("urn:zitadel:") && zitadelOrgId === "") {
    issue(
      "OIDC_ZITADEL_ORG_ID",
      "must be set when OIDC_ROLES_CLAIM is a Zitadel claim (otherwise an organisation the project is granted to could grant intranet roles)",
    );
  }
  const defaultRoleValue = trimmed(env.OIDC_DEFAULT_ROLE) || "deny";
  if (!(ENTRA_DEFAULT_ROLES as readonly string[]).includes(defaultRoleValue)) {
    issue("OIDC_DEFAULT_ROLE", `must be one of ${ENTRA_DEFAULT_ROLES.join(", ")}`);
  }
  const sessionTtl = trimmed(env.OIDC_SESSION_TTL) || DEFAULT_SESSION_TTL;
  const sessionTtlSeconds = parseSessionTtl(sessionTtl);
  if (sessionTtlSeconds === null) {
    issue("OIDC_SESSION_TTL", "must be <n>m, <n>h or <n>d, more than zero and at most 7d");
  }

  if (issues.length > 0) throw new OidcConfigError(issues);
  return {
    enabled: true,
    issuer,
    clientId,
    exchangeSecret,
    rolesClaim: rolesClaim.split("."),
    departmentClaim: departmentClaim === "" ? null : departmentClaim.split("."),
    zitadelOrgId: zitadelOrgId === "" ? null : zitadelOrgId,
    defaultRole: defaultRoleValue as EntraDefaultRole,
    sessionTtl,
    sessionTtlSeconds: sessionTtlSeconds as number,
    allowHttp,
    localEnabled: localSignInEnabled(env),
    localRegistration: env.LOCAL_REGISTRATION === "1",
  };
}

/** Boot warnings for a valid, enabled configuration. */
export function oidcConfigWarnings(settings: OidcSettings): string[] {
  if (!settings.enabled) return [];
  const warnings: string[] = [];
  if (settings.allowHttp) {
    warnings.push(
      "[oidc] OIDC_ALLOW_HTTP=1: the issuer, its discovery document and its signing keys may be fetched over plain http. Development and staging only.",
    );
  }
  if (settings.localRegistration) {
    warnings.push(
      "[oidc] LOCAL_REGISTRATION=1 next to OIDC sign-in: anyone can register a local account. " +
        "An OIDC user whose e-mail was registered first gets 409 oidc_account_exists; " +
        "check who registered that account before an admin binds it (docs/SSO.md, the 409 procedure).",
    );
  }
  return warnings;
}

/** The one `[oidc]` status line of every boot. */
export function oidcStatusLine(settings: OidcSettings): string {
  if (!settings.enabled) return "[oidc] disabled";
  return [
    "[oidc] enabled",
    `issuer=${settings.issuer}`,
    `default=${settings.defaultRole}`,
    `roles=${settings.rolesClaim.join(".")}`,
    `department=${settings.departmentClaim ? settings.departmentClaim.join(".") : "-"}`,
    `zitadelOrg=${settings.zitadelOrgId ?? "-"}`,
    `ttl=${settings.sessionTtl}`,
    `http=${settings.allowHttp ? 1 : 0}`,
    `local=${settings.localEnabled ? 1 : 0}`,
  ].join(" ");
}
