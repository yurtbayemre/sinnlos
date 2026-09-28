/**
 * Microsoft ID-token verification for the Entra exchange (D-ENTRA-01 spec E).
 *
 * The cms never issues a Strapi JWT for an identity it has not verified
 * itself: the web forwards the ID token Auth.js received, and this module
 * checks it with jose against the tenant's published signing keys:
 *   - signature: RS256 only (`alg: none`, HS256 and every other algorithm
 *     are refused before any key is looked up), keys from
 *     https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys;
 *   - iss = https://login.microsoftonline.com/<tenant>/v2.0 and tid = the
 *     tenant (a token of another tenant never passes);
 *   - aud = MS_CLIENT_ID;
 *   - iat at most 10 minutes old plus the 5 minutes of clock tolerance, so
 *     effectively 15 minutes (jose subtracts the tolerance from the age
 *     check; the exchange runs right after the sign-in); exp not passed,
 *     with the same tolerance;
 *   - oid, tid and iat present, oid a GUID.
 *
 * Result: `invalid` for every token problem, `unavailable` only when the
 * signing keys could not be fetched (network, timeout, a non-200 or a
 * malformed key set). A token signed by a key the set does not hold is
 * `invalid`. Errors carry jose's code or class name, never the token.
 *
 * The key set is created once per process and tenant (jose caches the keys
 * for 10 minutes and refetches on an unknown key id, at most every 30 s).
 * Tests pass `keys` (e.g. jose's createLocalJWKSet) instead; that seam is a
 * function argument only, nothing in the env can redirect the key source.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { GUID_PATTERN, entraIssuer, entraJwksUrl } from "./config";

/** The verified claims the exchange uses. */
export interface EntraIdClaims {
  /** Lower-cased tenant GUID (= the configured tenant). */
  tid: string;
  /** Lower-cased object id: with tid, the user's identity. */
  oid: string;
  name: string | null;
  email: string | null;
  preferredUsername: string | null;
  /** The app roles assigned to the user (the `roles` claim). */
  roles: string[];
}

export type IdTokenResult =
  | { ok: true; claims: EntraIdClaims }
  | { ok: false; reason: "invalid" | "unavailable"; detail: string };

export interface IdTokenVerifierConfig {
  tenantId: string;
  clientId: string;
}

export interface VerifyIdTokenOptions {
  /** Test seam: resolves the signing key instead of the tenant's key set. */
  keys?: JWTVerifyGetKey;
  /** Test seam: the verification time. */
  currentDate?: Date;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/** The tenant's remote key set, one per process and tenant. */
function tenantKeySet(tenantId: string): JWTVerifyGetKey {
  let keySet = remoteKeySets.get(tenantId);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(entraJwksUrl(tenantId)), { timeoutDuration: 5000 });
    remoteKeySets.set(tenantId, keySet);
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

/** jose's error code, else the error's class name; never a message with input in it. */
function errorCode(err: unknown): string {
  if (err instanceof errors.JOSEError) return err.code;
  if (err instanceof Error) return err.name;
  return "unknown";
}

/**
 * Wraps a key resolver so that a failure to GET the keys is told apart from
 * a token signed by an unknown key.
 */
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

const stringClaim = (payload: JWTPayload, name: string): string | null => {
  const value = payload[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

export async function verifyIdToken(
  idToken: string,
  config: IdTokenVerifierConfig,
  options: VerifyIdTokenOptions = {},
): Promise<IdTokenResult> {
  const tenantId = config.tenantId.toLowerCase();
  const keys = classifyingResolver(options.keys ?? tenantKeySet(tenantId));
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: entraIssuer(tenantId),
      audience: config.clientId,
      algorithms: ["RS256"],
      clockTolerance: "5 min",
      maxTokenAge: "10 min",
      requiredClaims: ["oid", "tid", "iat"],
      currentDate: options.currentDate,
    }));
  } catch (err) {
    if (err instanceof KeySetUnavailable) {
      return { ok: false, reason: "unavailable", detail: `jwks ${err.detail}` };
    }
    return { ok: false, reason: "invalid", detail: errorCode(err) };
  }

  const tid = stringClaim(payload, "tid")?.toLowerCase() ?? "";
  if (tid !== tenantId) return { ok: false, reason: "invalid", detail: "tid" };
  const oid = stringClaim(payload, "oid")?.toLowerCase() ?? "";
  if (!GUID_PATTERN.test(oid)) return { ok: false, reason: "invalid", detail: "oid" };
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role): role is string => typeof role === "string")
    : [];
  return {
    ok: true,
    claims: {
      tid,
      oid,
      name: stringClaim(payload, "name"),
      email: stringClaim(payload, "email"),
      preferredUsername: stringClaim(payload, "preferred_username"),
      roles,
    },
  };
}
