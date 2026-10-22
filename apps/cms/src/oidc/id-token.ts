/**
 * OIDC ID-token verification for the exchange (v0.25.0, deep-dive
 * plan-oidc.md findings 3, 8, 10, Codex S2, S4). The cms never issues a
 * Strapi JWT for an identity it has not verified itself; the web forwards the
 * ID token Auth.js received (Auth.js does not verify its signature in the code
 * flow, Codex V2), and this module checks it with jose:
 *   - discovery: `<issuer>/.well-known/openid-configuration`; its `issuer`
 *     must equal OIDC_ISSUER after URL normalisation (the way Auth.js
 *     compares it, so an origin-only issuer may be written with or without
 *     the slash, a path issuer exactly), and the token's `iss` must then
 *     equal the document's issuer exactly; `jwks_uri` must be https unless
 *     OIDC_ALLOW_HTTP=1. Cached per process for an hour;
 *   - signature: an asymmetric algorithm only (OIDC_ALGORITHMS: never HS*,
 *     whose key would be the client secret, never `none`), keys from
 *     `jwks_uri` (jose caches them and refetches on an unknown key id);
 *   - aud = OIDC_CLIENT_ID; with several audiences `azp` must be the
 *     client, and a present `azp` of another client is refused;
 *   - exp, iat and sub required; iat at most 10 minutes old plus 5 minutes
 *     of clock tolerance; sub a non-empty string of at most 255 characters,
 *     taken as it is (no case change: it is the identity);
 *   - e-mail: a non-empty `email` with `email_verified` exactly true, else
 *     `email_unverified` (Keycloak and authentik can let users register or
 *     change their address themselves);
 *   - OIDC_ZITADEL_ORG_ID: `urn:zitadel:iam:user:resourceowner:id` must be
 *     that organisation (`foreign_org`), and of an object-valued roles claim
 *     only the entries granted by it count (Zitadel finding 6).
 * Result: `invalid` for every token problem, `unavailable` only when the
 * discovery document or the signing keys could not be fetched or do not fit
 * the configuration. Details carry jose's code or a claim name, never the
 * token or a claim value.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import {
  MAX_IDENTITY_LENGTH,
  ZITADEL_METADATA_CLAIM,
  isAllowedUrl,
  type OidcConfig,
} from "./config";

/** Every asymmetric JWS algorithm jose verifies. */
export const OIDC_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

const ZITADEL_RESOURCE_OWNER_CLAIM = "urn:zitadel:iam:user:resourceowner:id";

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface Discovery {
  issuer: string;
  jwksUri: string;
}

export type DiscoveryResult = { ok: true; discovery: Discovery } | { ok: false; detail: string };

/** The verified claims the exchange uses. */
export interface OidcClaims {
  /** The discovery document's issuer, exactly (stored as oidcIssuer). */
  issuer: string;
  /** `sub`, exactly (stored as oidcSubject). */
  subject: string;
  /** Lower-cased. */
  email: string;
  name: string | null;
  /** The role names of OIDC_ROLES_CLAIM (empty when absent). */
  roles: string[];
  /** The value of OIDC_DEPARTMENT_CLAIM; null when not configured, absent or not a string. */
  department: string | null;
}

export type OidcTokenResult =
  | { ok: true; claims: OidcClaims }
  | {
      ok: false;
      reason: "invalid" | "unavailable" | "email_unverified" | "foreign_org";
      detail: string;
    };

export interface VerifyOidcOptions {
  /** Test seam: the discovery document instead of a fetch. */
  discovery?: Discovery;
  /** Test seam: resolves the signing key instead of jwks_uri. */
  keys?: JWTVerifyGetKey;
  /** Test seam: the verification time. */
  currentDate?: Date;
  /** Test seam: the fetch for the discovery document. */
  fetch?: typeof fetch;
}

const discoveries = new Map<string, { at: number; discovery: Discovery }>();
const keySets = new Map<string, JWTVerifyGetKey>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The discovery document's URL, built like oauth4webapi (Auth.js) builds it. */
export function discoveryUrl(issuer: string): string {
  return issuer.endsWith("/")
    ? `${issuer}.well-known/openid-configuration`
    : `${issuer}/.well-known/openid-configuration`;
}

/** Whether two issuer strings are the same URL (Auth.js's comparison). */
export function sameIssuer(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * The issuer's discovery document, checked against the configuration.
 * Never throws; the detail names what did not fit (issuer URLs are not
 * secret, so a mismatch names both).
 */
export async function discover(
  config: Pick<OidcConfig, "issuer" | "allowHttp">,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<DiscoveryResult> {
  const cached = discoveries.get(config.issuer);
  if (cached && now - cached.at < DISCOVERY_TTL_MS)
    return { ok: true, discovery: cached.discovery };
  let body: unknown;
  try {
    const response = await fetchImpl(discoveryUrl(config.issuer), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, detail: `discovery HTTP ${response.status}` };
    body = await response.json();
  } catch (err) {
    return { ok: false, detail: `discovery ${err instanceof Error ? err.name : "error"}` };
  }
  if (!isRecord(body) || typeof body.issuer !== "string" || typeof body.jwks_uri !== "string") {
    return { ok: false, detail: "discovery document without issuer or jwks_uri" };
  }
  if (!sameIssuer(body.issuer, config.issuer)) {
    return {
      ok: false,
      detail: `the discovery document's issuer ${body.issuer} is not OIDC_ISSUER ${config.issuer}`,
    };
  }
  if (!isAllowedUrl(body.jwks_uri, config.allowHttp)) {
    return { ok: false, detail: "jwks_uri is not https (OIDC_ALLOW_HTTP=1 allows http)" };
  }
  const discovery = { issuer: body.issuer, jwksUri: body.jwks_uri };
  discoveries.set(config.issuer, { at: now, discovery });
  return { ok: true, discovery };
}

function keySetFor(jwksUri: string): JWTVerifyGetKey {
  let keySet = keySets.get(jwksUri);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: FETCH_TIMEOUT_MS });
    keySets.set(jwksUri, keySet);
  }
  return keySet;
}

/** A key lookup that failed for a reason other than the token: the key set is unreachable. */
class KeySetUnavailable extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "KeySetUnavailable";
  }
}

function errorCode(err: unknown): string {
  if (err instanceof errors.JOSEError) return err.code;
  if (err instanceof Error) return err.name;
  return "unknown";
}

function classifyingResolver(keys: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await keys(header, token);
    } catch (err) {
      if (
        err instanceof errors.JWKSNoMatchingKey ||
        err instanceof errors.JWKSMultipleMatchingKeys
      ) {
        throw err;
      }
      throw new KeySetUnavailable(errorCode(err));
    }
  };
}

/** The value at a dot-separated claim path, or undefined. */
export function claimAt(payload: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = payload;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * The role names of a roles claim: an array of strings, or an object whose
 * keys are the roles (Zitadel: `{ role: { orgId: domain } }`). With
 * `orgId`, only object entries granted by that organisation count.
 */
export function roleNames(value: unknown, orgId: string | null): string[] {
  if (Array.isArray(value)) {
    return orgId === null ? value.filter((role): role is string => typeof role === "string") : [];
  }
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(
      ([, grants]) =>
        orgId === null || (isRecord(grants) && Object.prototype.hasOwnProperty.call(grants, orgId)),
    )
    .map(([role]) => role);
}

/** A department claim's value; base64url-decoded under Zitadel's metadata claim. */
export function departmentValue(
  payload: Record<string, unknown>,
  path: readonly string[] | null,
): string | null {
  if (path === null) return null;
  const value = claimAt(payload, path);
  if (typeof value !== "string") return null;
  if (path[0] !== ZITADEL_METADATA_CLAIM) return value;
  const normalized = value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const decoded = Buffer.from(normalized, "base64url").toString("utf8");
  // Not base64 (a lossy round trip): treat as absent rather than guess.
  return Buffer.from(decoded, "utf8").toString("base64url") === normalized ? decoded : null;
}

const stringClaim = (payload: JWTPayload, name: string): string | null => {
  const value = payload[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

export async function verifyOidcIdToken(
  idToken: string,
  config: OidcConfig,
  options: VerifyOidcOptions = {},
): Promise<OidcTokenResult> {
  let discovery = options.discovery;
  if (!discovery) {
    const found = await discover(config, options.fetch);
    if (found.ok === false) return { ok: false, reason: "unavailable", detail: found.detail };
    discovery = found.discovery;
  }
  const keys = classifyingResolver(options.keys ?? keySetFor(discovery.jwksUri));
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: discovery.issuer,
      audience: config.clientId,
      algorithms: OIDC_ALGORITHMS,
      clockTolerance: "5 min",
      maxTokenAge: "10 min",
      requiredClaims: ["sub", "iat", "exp"],
      currentDate: options.currentDate,
    }));
  } catch (err) {
    if (err instanceof KeySetUnavailable) {
      return { ok: false, reason: "unavailable", detail: `jwks ${err.detail}` };
    }
    return { ok: false, reason: "invalid", detail: errorCode(err) };
  }

  const subject = payload.sub;
  if (typeof subject !== "string" || subject === "" || subject.length > MAX_IDENTITY_LENGTH) {
    return { ok: false, reason: "invalid", detail: "sub" };
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((audiences.length > 1 || payload.azp !== undefined) && payload.azp !== config.clientId) {
    return { ok: false, reason: "invalid", detail: "azp" };
  }
  const email = stringClaim(payload, "email")?.toLowerCase() ?? null;
  if (email === null || email.length > MAX_IDENTITY_LENGTH || payload.email_verified !== true) {
    return { ok: false, reason: "email_unverified", detail: "email_verified" };
  }
  const claims = payload as Record<string, unknown>;
  if (
    config.zitadelOrgId !== null &&
    claims[ZITADEL_RESOURCE_OWNER_CLAIM] !== config.zitadelOrgId
  ) {
    return { ok: false, reason: "foreign_org", detail: "resourceowner" };
  }
  return {
    ok: true,
    claims: {
      issuer: discovery.issuer,
      subject,
      email,
      name: stringClaim(payload, "name"),
      roles: roleNames(claimAt(claims, config.rolesClaim), config.zitadelOrgId),
      department: departmentValue(claims, config.departmentClaim),
    },
  };
}
