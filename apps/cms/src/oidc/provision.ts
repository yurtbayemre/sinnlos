/**
 * POST /api/auth/oidc/exchange: turns an OIDC sign-in (Keycloak, authentik,
 * Zitadel; v0.25.0, deep-dive plan-oidc.md) into a Strapi JWT. Called
 * server-to-server by the web's Auth.js signIn callback with the ID token of
 * a completed code flow. The Entra exchange (entra/provision.ts) is the
 * model; the steps both share live in idp/exchange-core.ts. In this order:
 *   1. the shared secret (x-oidc-exchange-secret), in constant time;
 *   2. the cms's own verification of the ID token (id-token.ts): issuer,
 *      signature, audience, age, sub, a verified e-mail, the Zitadel
 *      organisation;
 *   3. the role from OIDC_ROLES_CLAIM: the highest `Intranet.*` name
 *      (APP_ROLE_TABLE), else OIDC_DEFAULT_ROLE (deny by default). The
 *      provider's role is the admission gate (owner decision 2026-10-22): a
 *      deny refuses even a user whose role an admin set by hand; a hand-set
 *      role only decides WHICH role (decideRoleWrite with admission);
 *   4. the identity (oidcIssuer = the discovery document's issuer, oidcSubject
 *      = sub, both exactly), never an e-mail match; 409 account_exists,
 *      the create race, blocked and the locked role write: admitIdentity;
 *   5. the profile of an existing user: the name (non-empty only) and, for a
 *      row this exchange created (provider 'oidc'), the e-mail unless another
 *      row uses it; then, with OIDC_DEPARTMENT_CLAIM, the department. Each
 *      write is its own statement with its own try/catch: logged, never fatal;
 *   6. a Strapi JWT for OIDC_SESSION_TTL.
 * One audit line per exchange (`[oidc] user=… sub=<hash> result=…`); the
 * subject is logged only as a short hash (it can be a username or an
 * address), and no token is ever logged or stored.
 */
import { createHash } from "node:crypto";
import { ROLE_PRIVILEGE_ORDER, type RoleType } from "../bootstrap/roles";
import { APP_ROLE_TABLE } from "../entra/config";
import { capUserText, decideEmailSync } from "../entra/profile";
import { decideRoleWrite, type RoleResolution } from "../entra/roles";
import {
  admitIdentity,
  errorLabel,
  fail,
  isRecord,
  issueSession,
  secretMatches,
  stringOf,
  syncDepartment,
  USER_UID,
  type ExchangeError,
  type ExchangeHost,
  type ExchangeOutcome,
  type ExchangeRequest,
  type Row,
} from "../idp/exchange-core";
import type { EntraDefaultRole } from "../entra/config";
import type { OidcConfig } from "./config";
import { verifyOidcIdToken, type OidcClaims, type OidcTokenResult } from "./id-token";

/** The header the web sends the shared secret in. */
export const OIDC_EXCHANGE_SECRET_HEADER = "x-oidc-exchange-secret";

/** idToken: at most this many bytes. */
export const MAX_ID_TOKEN_BYTES = 16 * 1024;

/** The profile fields PUT /api/me refuses for a user bound to OIDC. */
export const OIDC_MANAGED_PROFILE_FIELDS = ["displayName"] as const;

export interface OidcExchangeDeps {
  /** Test seam: the ID-token check (default: id-token.ts against the issuer's keys). */
  verify?: (idToken: string, config: OidcConfig) => Promise<OidcTokenResult>;
}

/** The ID token, when it is a non-empty string of at most 16 KB. */
export function readIdToken(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const { idToken } = body;
  return typeof idToken === "string" &&
    idToken !== "" &&
    Buffer.byteLength(idToken, "utf8") <= MAX_ID_TOKEN_BYTES
    ? idToken
    : null;
}

/** The first 8 hex characters of a hash of the identity: what log lines show of it. */
export function subjectRef(issuer: string, subject: string): string {
  return createHash("sha256").update(`${issuer}\n${subject}`, "utf8").digest("hex").slice(0, 8);
}

/** A new row's username: unique per identity, a fixed shape whatever the subject holds. */
export function oidcUsername(issuer: string, subject: string): string {
  const hash = createHash("sha256").update(`${issuer}\n${subject}`, "utf8").digest("hex");
  return `oidc-${hash.slice(0, 32)}`;
}

/** The highest `Intranet.*` role of the claim, else the default (deny by default). */
export function resolveOidcRole(
  roles: readonly string[],
  defaultRole: EntraDefaultRole,
): RoleResolution {
  const rank = (role: RoleType) => ROLE_PRIVILEGE_ORDER.indexOf(role);
  const matches = roles.flatMap((name) =>
    Object.prototype.hasOwnProperty.call(APP_ROLE_TABLE, name)
      ? [{ role: APP_ROLE_TABLE[name], via: `role:${name}` }]
      : [],
  );
  if (matches.length > 0) {
    const role = matches.reduce(
      (best, m) => (rank(m.role) < rank(best) ? m.role : best),
      matches[0].role,
    );
    return {
      kind: "role",
      role,
      via: [...new Set(matches.filter((m) => m.role === role).map((m) => m.via))],
    };
  }
  if (defaultRole === "deny") return { kind: "deny" };
  return { kind: "role", role: defaultRole, via: ["default"] };
}

/** What the audit line of one exchange says. */
interface Audit {
  user: string;
  sub: string;
  result: "created" | "existing" | "conflict" | "denied" | "blocked" | "unavailable";
  role: string;
  via: string;
  extra: string[];
}

const USER_SELECT = ["id", "documentId", "username", "email", "provider", "blocked", "displayName"];
const USER_POPULATE = { department: { select: ["id", "documentId"] } };

/**
 * The exchange for an enabled configuration. Every outcome is an explicit
 * status and body; unexpected errors propagate to the controller (503).
 */
export async function runOidcExchange(
  strapi: ExchangeHost,
  settings: OidcConfig,
  request: ExchangeRequest,
  deps: OidcExchangeDeps = {},
): Promise<ExchangeOutcome> {
  if (!secretMatches(request.secret, settings.exchangeSecret)) {
    strapi.log.warn("[oidc] exchange refused: missing or wrong exchange secret");
    return fail(401, "unauthorized");
  }
  const idToken = readIdToken(request.body);
  if (idToken === null) {
    strapi.log.warn("[oidc] exchange refused: idToken missing, empty or over 16 KB");
    return fail(400, "invalid");
  }
  const verify =
    deps.verify ?? ((token: string, config: OidcConfig) => verifyOidcIdToken(token, config));
  const verified = await verify(idToken, settings);
  if (verified.ok === false) {
    switch (verified.reason) {
      case "unavailable":
        strapi.log.error(`[oidc] exchange failed: ${verified.detail}`);
        return fail(503, "unavailable");
      case "email_unverified":
        strapi.log.warn("[oidc] exchange refused: no verified e-mail address in the ID token");
        return fail(403, "email_unverified");
      case "foreign_org":
        strapi.log.warn(
          "[oidc] exchange refused: the user belongs to another Zitadel organisation",
        );
        return fail(403, "not_assigned");
      default:
        strapi.log.warn(`[oidc] exchange refused: invalid ID token (${verified.detail})`);
        return fail(401, "invalid");
    }
  }
  const claims = verified.claims;
  const resolution = resolveOidcRole(claims.roles, settings.defaultRole);
  const audit: Audit = {
    user: "new",
    sub: subjectRef(claims.issuer, claims.subject),
    result: "unavailable",
    role: "-",
    via: resolution.kind === "role" ? resolution.via.join("+") : "-",
    extra: [],
  };

  const outcome = await provision(strapi, settings, claims, resolution, audit);
  const extra = audit.extra.length > 0 ? ` ${audit.extra.join(" ")}` : "";
  strapi.log.info(
    `[oidc] user=${audit.user} sub=${audit.sub} result=${audit.result} role=${audit.role} via=${audit.via}${extra}`,
  );
  if (outcome.kind === "refused") return fail(outcome.status, outcome.error);

  const { jwt, expiresAt } = await issueSession(
    strapi,
    outcome.user.id,
    settings.sessionTtl,
    settings.sessionTtlSeconds,
  );
  // Built field by field: never a database row.
  return {
    status: 200,
    body: {
      jwt,
      expiresAt,
      user: {
        id: outcome.user.id,
        displayName: outcome.user.displayName,
        email: outcome.user.email,
      },
    },
  };
}

type ProvisionOutcome =
  | { kind: "refused"; status: 403 | 409 | 503; error: ExchangeError }
  | { kind: "ok"; user: { id: number; displayName: string; email: string } };

async function provision(
  strapi: ExchangeHost,
  settings: OidcConfig,
  claims: OidcClaims,
  resolution: RoleResolution,
  audit: Audit,
): Promise<ProvisionOutcome> {
  const admitted = await admitIdentity(
    strapi,
    {
      log: "[oidc]",
      ref: `sub=${audit.sub}`,
      identity: { oidcIssuer: claims.issuer, oidcSubject: claims.subject },
      select: USER_SELECT,
      populate: USER_POPULATE,
      email: claims.email,
      decide: (user) =>
        decideRoleWrite(user, resolution, "on", { source: "oidc", admission: true }),
      newRow: (role, email) => ({
        username: oidcUsername(claims.issuer, claims.subject),
        provider: "oidc",
        roleSource: "oidc",
        entraAppliedRole: role,
        oidcIssuer: claims.issuer,
        oidcSubject: claims.subject,
        displayName: capUserText(claims.name ?? email),
      }),
    },
    audit,
  );
  if (admitted.kind === "refused") return admitted;
  const { user, created } = admitted;

  if (!created) await syncProfile(strapi, user, claims);
  if (settings.departmentClaim !== null) {
    const name = claims.department?.trim() || null;
    audit.extra.push(
      `department=${await syncDepartment(strapi, user, name, true, "[oidc]", "OIDC")}`,
    );
  }

  const final =
    (await strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      select: ["id", "username", "email", "displayName"],
    })) ?? user;
  return {
    kind: "ok",
    user: {
      id: user.id,
      displayName: stringOf(final.displayName) ?? stringOf(final.username) ?? "",
      email: stringOf(final.email) ?? "",
    },
  };
}

/** The OIDC-owned name and (provider oidc) the e-mail of an existing user. */
async function syncProfile(strapi: ExchangeHost, user: Row, claims: OidcClaims): Promise<void> {
  const users = strapi.db.query(USER_UID);
  const data: Record<string, unknown> = {};
  if (claims.name !== null) {
    const displayName = capUserText(claims.name);
    if (displayName !== stringOf(user.displayName)) data.displayName = displayName;
  }
  try {
    if (stringOf(user.provider) === "oidc") {
      const taken = await users.findOne({
        where: { email: { $eqi: claims.email }, id: { $ne: user.id } },
        select: ["id"],
      });
      const email = decideEmailSync(claims.email, stringOf(user.email), taken !== null);
      if (email.kind === "set") data.email = email.email;
      else if (email.reason === "conflict") {
        strapi.log.warn(
          `[oidc] user=${user.id}: the e-mail address from the identity provider is used by another account; kept the stored one`,
        );
      }
    }
  } catch (err) {
    strapi.log.error(`[oidc] user=${user.id}: e-mail check failed (${errorLabel(err)})`);
  }
  if (Object.keys(data).length === 0) return;
  try {
    await users.update({ where: { id: user.id }, data });
  } catch (err) {
    strapi.log.error(`[oidc] user=${user.id}: profile sync failed (${errorLabel(err)})`);
  }
}
