/**
 * POST /api/auth/entra/exchange: turns a Microsoft sign-in into a Strapi
 * JWT (D-ENTRA-01 spec D, F, I, J, K, N). Called server-to-server by the
 * web's Auth.js signIn callback (apps/web/src/lib/entra-exchange.ts) with
 * the ID token and the Graph access token of a completed OIDC sign-in.
 *
 * The route is auth:false, and the edge does not protect it (Strapi's
 * routes are case-insensitive, middlewares/auth-path-guard.ts refuses the
 * case variants). Its security rests on two checks, both here:
 *   1. the shared secret (x-entra-exchange-secret), compared in constant
 *      time over sha256 digests;
 *   2. the cms's own verification of the ID token (id-token.ts): only a
 *      real token of THIS tenant and app gets through, its iat at most 10
 *      minutes old plus 5 minutes of clock tolerance (effectively 15).
 *
 * Then, in this order:
 *   - Graph /me (and checkMemberGroups, /me/manager when configured) in
 *     parallel; a /me id other than the token's oid is refused (401);
 *   - the identity is (tid, oid): a row with that pair, never an e-mail
 *     match. A new identity whose address a row already uses gets 409
 *     entra_account_exists (an admin binds that row once its owner is
 *     confirmed, or deletes it: docs/DEPLOYMENT.md, the 409 procedure). Concurrent
 *     first sign-ins race on up_users_entra_identity_uq: the loser re-reads
 *     and continues with the winner's row, and so does one whose e-mail
 *     check already sees the winner's row (409 only when the identity is
 *     still absent, i.e. the address belongs to another row);
 *   - a blocked row gets 403; the role is resolved and written (roles.ts:
 *     deny 403 not_assigned, a new user whose role cannot be decided 503);
 *   - with mode 'on' the Entra-owned profile, the department and the
 *     manager are synced (profile.ts), each write a separate statement in
 *     its own try/catch: a failed optional write is logged, never fatal.
 *     Dry-run creates new users (capped at member) but never changes an
 *     existing one, and only logs department and manager;
 *   - a Strapi JWT for ENTRA_SESSION_TTL, and an explicit response body.
 * One audit line per exchange (`[entra] user=… oid=… result=…`); no token,
 * no Graph payload and no JWT is ever logged or stored. A failed write logs
 * the step, the user id and the error's code (errorLabel), never its
 * message: knex puts the SQL and its bound values (the profile) there.
 *
 * The steps every identity provider shares (secret check, identity, 409,
 * create race, blocked, locked role write, JWT) live in
 * idp/exchange-core.ts since v0.24.0; this module keeps the Entra parts.
 *
 * No enclosing transaction, only two short ones: around the identity insert
 * (row and role link commit together) and around an existing user's role
 * decision and write (a fresh, on Postgres locked read of the row). Strapi's
 * db.query create() and update() commit a row and its relations separately,
 * so spec F's "the insert is its own statement" does not hold on its own,
 * and a concurrent exchange could otherwise read a half-written role as an
 * admin's change. The profile, department and manager writes stay outside
 * any transaction, so no Postgres aborted-transaction trap can take them, or
 * the sign-in, down.
 */
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
import type { EntraConfig } from "./config";
import {
  checkMemberGroups,
  describeGraphResult,
  fetchGraphMe,
  fetchManagerOid,
  type GraphMe,
  type GraphOptions,
  type GraphResult,
} from "./graph";
import { verifyIdToken, type EntraIdClaims, type IdTokenResult } from "./id-token";
import {
  buildProfileUpdate,
  capUserText,
  decideEmailSync,
  decideManagerSync,
  departmentName,
  managerBackfillWhere,
  newIdentityEmail,
  syncedEmail,
} from "./profile";
import { decideRoleWrite, resolveEntraRole, type RoleResolution } from "./roles";

export { DEPARTMENT_UID } from "../idp/exchange-core";

/** The header the web sends the shared secret in. */
export const EXCHANGE_SECRET_HEADER = "x-entra-exchange-secret";

/** idToken and accessToken: at most this many bytes each. */
export const MAX_TOKEN_BYTES = 16 * 1024;

export interface ExchangeDeps {
  /** Test seam: the ID-token check (default: id-token.ts against the tenant's keys). */
  verify?: (idToken: string, config: EntraConfig) => Promise<IdTokenResult>;
  /** Test seam: Graph's fetch. */
  graph?: GraphOptions;
}

/** The two tokens, when both are non-empty strings of at most 16 KB. */
export function readTokens(body: unknown): { idToken: string; accessToken: string } | null {
  if (!isRecord(body)) return null;
  const { idToken, accessToken } = body;
  const ok = (value: unknown): value is string =>
    typeof value === "string" &&
    value !== "" &&
    Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES;
  return ok(idToken) && ok(accessToken) ? { idToken, accessToken } : null;
}

const relationId = (value: unknown): number | null =>
  isRecord(value) && typeof value.id === "number" ? value.id : null;

/** What the audit line of one exchange says. */
interface Audit {
  user: string;
  oid: string;
  result: "created" | "existing" | "conflict" | "denied" | "blocked" | "unavailable";
  role: string;
  via: string;
  extra: string[];
}

function viaOf(resolution: RoleResolution | null): string {
  return resolution?.kind === "role" ? resolution.via.join("+") : "-";
}

/**
 * The exchange for an enabled configuration. Every outcome is an explicit
 * status and body; unexpected errors propagate to the controller (503).
 */
export async function runEntraExchange(
  strapi: ExchangeHost,
  settings: EntraConfig,
  request: ExchangeRequest,
  deps: ExchangeDeps = {},
): Promise<ExchangeOutcome> {
  if (!secretMatches(request.secret, settings.exchangeSecret)) {
    strapi.log.warn("[entra] exchange refused: missing or wrong exchange secret");
    return fail(401, "unauthorized");
  }
  const tokens = readTokens(request.body);
  if (!tokens) {
    strapi.log.warn("[entra] exchange refused: idToken/accessToken missing, empty or over 16 KB");
    return fail(400, "invalid");
  }

  const verify =
    deps.verify ?? ((token: string, config: EntraConfig) => verifyIdToken(token, config));
  const verified = await verify(tokens.idToken, settings);
  if (verified.ok === false) {
    if (verified.reason === "unavailable") {
      strapi.log.error(
        `[entra] exchange failed: the tenant's signing keys are unreachable (${verified.detail})`,
      );
      return fail(503, "unavailable");
    }
    strapi.log.warn(`[entra] exchange refused: invalid ID token (${verified.detail})`);
    return fail(401, "invalid");
  }
  const claims = verified.claims;

  const graphOptions = deps.graph ?? {};
  const [me, groups, manager] = await Promise.all([
    fetchGraphMe(tokens.accessToken, graphOptions),
    settings.groupIds.length > 0
      ? checkMemberGroups(tokens.accessToken, settings.groupIds, graphOptions)
      : Promise.resolve(null),
    settings.syncManager
      ? fetchManagerOid(tokens.accessToken, graphOptions)
      : Promise.resolve(null),
  ]);
  const graphLine = `me:${describeGraphResult(me)},groups:${describeGraphResult(groups)},manager:${describeGraphResult(manager)}`;
  const oidShort = claims.oid.slice(0, 8);

  if (me.ok === true && me.data.id !== claims.oid) {
    strapi.log.warn(
      `[entra] exchange refused: Graph /me is not the token's user (oid=${oidShort})`,
    );
    return fail(401, "invalid");
  }

  const audit: Audit = {
    user: "new",
    oid: oidShort,
    result: "unavailable",
    role: "-",
    via: "-",
    extra: [],
  };
  const writeAudit = () => {
    const extra = audit.extra.length > 0 ? ` ${audit.extra.join(" ")}` : "";
    strapi.log.info(
      `[entra] user=${audit.user} oid=${audit.oid} result=${audit.result} role=${audit.role} via=${audit.via} mode=${settings.syncMode} graph=${graphLine}${extra}`,
    );
  };

  const outcome = await provision(strapi, settings, claims, { me, groups, manager }, audit);
  writeAudit();
  if (outcome.kind === "refused") return fail(outcome.status, outcome.error);

  const { jwt, expiresAt } = await issueSession(
    strapi,
    outcome.user.id,
    settings.sessionTtl,
    settings.sessionTtlSeconds,
  );
  // Built field by field (spec D.12): never a database row.
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

interface GraphResults {
  me: GraphResult<GraphMe>;
  groups: GraphResult<string[]> | null;
  manager: GraphResult<string | null> | null;
}

type ProvisionOutcome =
  | { kind: "refused"; status: 403 | 409 | 503; error: ExchangeError }
  | { kind: "ok"; user: { id: number; displayName: string; email: string } };

/** The user columns and relations the exchange reads. */
const USER_SELECT = [
  "id",
  "documentId",
  "username",
  "email",
  "provider",
  "blocked",
  "displayName",
  "roleSource",
  "entraAppliedRole",
  "entraManagerOid",
];
const USER_POPULATE = {
  role: { select: ["id", "type"] },
  department: { select: ["id", "documentId"] },
  manager: { select: ["id"] },
};

async function provision(
  strapi: ExchangeHost,
  settings: EntraConfig,
  claims: EntraIdClaims,
  graph: GraphResults,
  audit: Audit,
): Promise<ProvisionOutcome> {
  const users = strapi.db.query(USER_UID);
  const resolution = resolveEntraRole({
    claimRoles: claims.roles,
    me: graph.me,
    groups: graph.groups,
    groupRules: settings.groupRules,
    defaultRole: settings.defaultRole,
  });
  audit.via = viaOf(resolution);
  const me = graph.me.ok === true ? graph.me.data : null;

  // The identity, the 409, the create race, blocked and the role write:
  // idp/exchange-core.ts (spec F, I).
  const admitted = await admitIdentity(
    strapi,
    {
      log: "[entra]",
      ref: `oid=${audit.oid}`,
      identity: { entraTenantId: claims.tid, microsoftOid: claims.oid },
      select: USER_SELECT,
      populate: USER_POPULATE,
      email: newIdentityEmail(me, claims),
      decide: (user) => decideRoleWrite(user, resolution, settings.syncMode),
      newRow: (role, email) => {
        const scalars = me ? buildProfileUpdate(me) : null;
        return {
          username: `entra-${claims.oid}`,
          provider: "microsoft",
          roleSource: "entra",
          entraAppliedRole: role,
          entraTenantId: claims.tid,
          microsoftOid: claims.oid,
          ...(scalars ?? {}),
          displayName: scalars?.displayName ?? capUserText(claims.name ?? email),
        };
      },
    },
    audit,
  );
  if (admitted.kind === "refused") return admitted;
  const { user, created } = admitted;

  const mayWrite = settings.syncMode === "on";
  if (me && !created) {
    if (mayWrite) await syncProfile(strapi, user, me);
  }
  if (settings.syncDepartment) {
    audit.extra.push(
      `department=${me ? await syncDepartment(strapi, user, departmentName(me), mayWrite, "[entra]", "Entra") : "unknown"}`,
    );
  }
  if (settings.syncManager && graph.manager !== null) {
    // Like the profile and the department: nothing without a successful
    // /me (spec J); the back-fill waits for the next sign-in then.
    audit.extra.push(
      `manager=${me ? await syncManager(strapi, user, claims, graph.manager, mayWrite) : "unknown"}`,
    );
  }

  const final =
    (await users.findOne({
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

/** The Entra-owned scalars and (provider microsoft) the e-mail of an existing user. */
async function syncProfile(strapi: ExchangeHost, user: Row, me: GraphMe): Promise<void> {
  const users = strapi.db.query(USER_UID);
  const data: Record<string, unknown> = { ...buildProfileUpdate(me) };
  try {
    const candidate = syncedEmail(me, stringOf(user.provider));
    if (candidate !== null) {
      const taken = await users.findOne({
        where: { email: { $eqi: candidate }, id: { $ne: user.id } },
        select: ["id"],
      });
      const email = decideEmailSync(candidate, stringOf(user.email), taken !== null);
      if (email.kind === "set") data.email = email.email;
      else if (email.reason === "conflict") {
        strapi.log.warn(
          `[entra] user=${user.id}: the e-mail address from Entra is used by another account; kept the stored one`,
        );
      }
    }
  } catch (err) {
    strapi.log.error(`[entra] user=${user.id}: e-mail check failed (${errorLabel(err)})`);
  }
  try {
    await users.update({ where: { id: user.id }, data });
  } catch (err) {
    strapi.log.error(`[entra] user=${user.id}: profile sync failed (${errorLabel(err)})`);
  }
}

/** ENTRA_SYNC_MANAGER=1: the manager, then the users waiting for this one. */
async function syncManager(
  strapi: ExchangeHost,
  user: Row,
  claims: EntraIdClaims,
  result: GraphResult<string | null>,
  mayWrite: boolean,
): Promise<string> {
  const users = strapi.db.query(USER_UID);
  const decision = decideManagerSync(result);
  let outcome = "keep";
  try {
    if (decision.kind === "clear") {
      const hasManager =
        relationId(user.manager) !== null || stringOf(user.entraManagerOid) !== null;
      if (!hasManager) outcome = "unchanged";
      else if (!mayWrite) outcome = "would clear";
      else {
        await users.update({
          where: { id: user.id },
          data: { manager: null, entraManagerOid: null },
        });
        outcome = "cleared";
      }
    } else if (decision.kind === "set") {
      const boss = await users.findOne({
        where: { entraTenantId: claims.tid, microsoftOid: decision.managerOid },
        select: ["id"],
      });
      const bossId = boss && boss.id !== user.id ? boss.id : null;
      const unchanged =
        stringOf(user.entraManagerOid) === decision.managerOid &&
        relationId(user.manager) === bossId;
      if (unchanged) outcome = bossId === null ? "pending" : "unchanged";
      else if (!mayWrite) outcome = bossId === null ? "would pend" : "would set";
      else {
        await users.update({
          where: { id: user.id },
          data: { entraManagerOid: decision.managerOid, manager: bossId },
        });
        outcome = bossId === null ? "pending" : "set";
      }
    }
  } catch (err) {
    strapi.log.error(`[entra] user=${user.id}: manager sync failed (${errorLabel(err)})`);
    outcome = "failed";
  }
  if (!mayWrite) return outcome;
  try {
    const waiting = await users.findMany({
      where: managerBackfillWhere(claims.tid, claims.oid),
      select: ["id"],
      populate: { manager: { select: ["id"] } },
    });
    let linked = 0;
    for (const report of waiting) {
      if (report.id === user.id || relationId(report.manager) === user.id) continue;
      await users.update({ where: { id: report.id }, data: { manager: user.id } });
      linked += 1;
    }
    if (linked > 0) return `${outcome} backfilled=${linked}`;
  } catch (err) {
    strapi.log.error(`[entra] user=${user.id}: manager back-fill failed (${errorLabel(err)})`);
  }
  return outcome;
}
