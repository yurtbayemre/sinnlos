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
 *      real, at most 10-minute-old token of THIS tenant and app gets through.
 *
 * Then, in this order:
 *   - Graph /me (and checkMemberGroups, /me/manager when configured) in
 *     parallel; a /me id other than the token's oid is refused (401);
 *   - the identity is (tid, oid): a row with that pair, never an e-mail
 *     match. A new identity whose address a row already uses gets 409
 *     entra_account_exists (an admin binds that row instead). Concurrent
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
 * no Graph payload and no JWT is ever logged or stored.
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
import { createHash, timingSafeEqual } from "node:crypto";
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
  decideEmailSync,
  decideManagerSync,
  departmentName,
  managerBackfillWhere,
  newIdentityEmail,
  pickDepartment,
  syncedEmail,
} from "./profile";
import { decideRoleWrite, resolveEntraRole, type RoleResolution } from "./roles";

export const USER_UID = "plugin::users-permissions.user";
export const ROLE_UID = "plugin::users-permissions.role";
export const DEPARTMENT_UID = "api::department.department";

/** The header the web sends the shared secret in. */
export const EXCHANGE_SECRET_HEADER = "x-entra-exchange-secret";

/** idToken and accessToken: at most this many bytes each. */
export const MAX_TOKEN_BYTES = 16 * 1024;

/** The error codes of the exchange; the web maps them to /sign-in?error=entra_<code>. */
export type ExchangeError =
  | "unauthorized"
  | "invalid"
  | "account_exists"
  | "not_assigned"
  | "blocked"
  | "unavailable";

export interface ExchangeSuccess {
  jwt: string;
  /** exp of the jwt, epoch seconds. */
  expiresAt: number;
  user: { id: number; displayName: string; email: string };
}

export type ExchangeOutcome =
  | { status: 200; body: ExchangeSuccess }
  | { status: 400 | 401 | 403 | 409 | 503; body: { error: ExchangeError } };

type Row = Record<string, unknown> & { id: number };

interface Query {
  findOne(params: Record<string, unknown>): Promise<Row | null>;
  findMany(params: Record<string, unknown>): Promise<Row[]>;
  create(params: { data: Record<string, unknown> }): Promise<Row>;
  update(params: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<Row | null>;
}

/** The query builder slice that locks a user row (Postgres). */
interface LockQuery {
  select(columns: string[]): LockQuery;
  where(where: Record<string, unknown>): LockQuery;
  forUpdate(): LockQuery;
  execute(): Promise<unknown>;
}

/** The slice of the Strapi instance the exchange uses. */
export interface ExchangeHost {
  db: {
    query(uid: string): Query;
    /**
     * One transaction around `callback`: every query inside joins it
     * (@strapi/database keeps it in AsyncLocalStorage, and a nested
     * transaction() reuses it), commit on return, rollback on a throw.
     */
    transaction<T>(callback: () => Promise<T>): Promise<T>;
    queryBuilder(uid: string): LockQuery;
    /** 'postgres' or 'sqlite'. */
    dialect: { client: string };
  };
  documents(uid: string): {
    findMany(params: Record<string, unknown>): Promise<{ documentId: string }[]>;
    update(params: { documentId: string; data: Record<string, unknown> }): Promise<unknown>;
  };
  plugin(name: string): { service(name: string): unknown };
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface ExchangeDeps {
  /** Test seam: the ID-token check (default: id-token.ts against the tenant's keys). */
  verify?: (idToken: string, config: EntraConfig) => Promise<IdTokenResult>;
  /** Test seam: Graph's fetch. */
  graph?: GraphOptions;
}

export interface ExchangeRequest {
  /** The x-entra-exchange-secret header, as received. */
  secret: unknown;
  body: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (status: 400 | 401 | 403 | 409 | 503, error: ExchangeError): ExchangeOutcome => ({
  status,
  body: { error },
});

/** Constant-time comparison of the header with the configured secret. */
export function secretMatches(header: unknown, secret: string): boolean {
  if (typeof header !== "string" || header === "" || secret === "") return false;
  const given = createHash("sha256").update(header, "utf8").digest();
  const expected = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(given, expected);
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

/** exp of a JWT the cms just issued (payload decoded, not verified). */
function jwtExp(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

const stringOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
const relationId = (value: unknown): number | null =>
  isRecord(value) && typeof value.id === "number" ? value.id : null;
const relationDocumentId = (value: unknown): string | null =>
  isRecord(value) && typeof value.documentId === "string" ? value.documentId : null;

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

  const jwtService = strapi.plugin("users-permissions").service("jwt") as {
    issue(payload: { id: number }, options: { expiresIn: string }): string | Promise<string>;
  };
  const jwt = await jwtService.issue({ id: outcome.user.id }, { expiresIn: settings.sessionTtl });
  const expiresAt = jwtExp(jwt) ?? Math.floor(Date.now() / 1000) + settings.sessionTtlSeconds;
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
  const identity = { entraTenantId: claims.tid, microsoftOid: claims.oid };
  const findIdentity = () =>
    users.findOne({ where: identity, select: USER_SELECT, populate: USER_POPULATE });
  const resolution = resolveEntraRole({
    claimRoles: claims.roles,
    me: graph.me,
    groups: graph.groups,
    groupRules: settings.groupRules,
    defaultRole: settings.defaultRole,
  });
  audit.via = viaOf(resolution);
  const me = graph.me.ok === true ? graph.me.data : null;

  let user = await findIdentity();
  let created = false;
  if (!user) {
    const email = newIdentityEmail(me, claims);
    if (email === null) {
      strapi.log.warn(
        `[entra] exchange refused: no e-mail address for a new identity (oid=${audit.oid})`,
      );
      audit.result = "unavailable";
      return { kind: "refused", status: 503, error: "unavailable" };
    }
    // No automatic linking by e-mail (the nOAuth risk class): an admin binds
    // the existing row by entering tenant and object id on it.
    const taken = await users.findOne({ where: { email: { $eqi: email } }, select: ["id"] });
    if (taken) {
      // The row with this address can be this very identity: a concurrent
      // first sign-in of the same person created it between the lookup
      // above and this check. Continue as that existing user (spec F); only
      // an address of ANOTHER row is a conflict.
      user = await findIdentity();
      if (!user) {
        audit.result = "conflict";
        return { kind: "refused", status: 409, error: "account_exists" };
      }
      strapi.log.info(
        `[entra] concurrent first sign-in (oid=${audit.oid}): continuing with the existing row`,
      );
    } else {
      const outcome = await createIdentity(strapi, claims, me, email, resolution, settings, audit);
      if (outcome.kind === "refused") return outcome;
      created = outcome.created;
      user = await findIdentity();
      if (!user) throw new Error("the provisioned user row could not be read back");
    }
  }

  audit.user = String(user.id);
  if (!created) {
    if (user.blocked === true) {
      audit.result = "blocked";
      audit.role = "keep";
      return { kind: "refused", status: 403, error: "blocked" };
    }
    const step = await writeRole(strapi, user.id, resolution, settings.syncMode);
    audit.role = step.audit;
    if (step.kind === "refused") {
      audit.result = step.status === 403 ? "denied" : "unavailable";
      return { kind: "refused", status: step.status, error: step.error };
    }
    audit.result = "existing";
  } else {
    audit.result = "created";
  }

  const mayWrite = settings.syncMode === "on";
  if (me && !created) {
    if (mayWrite) await syncProfile(strapi, user, me);
  }
  if (settings.syncDepartment) {
    audit.extra.push(`department=${await syncDepartment(strapi, user, me, mayWrite)}`);
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

type CreateOutcome =
  | { kind: "refused"; status: 403 | 409 | 503; error: ExchangeError }
  /** created false: a concurrent first sign-in of the same person won the unique index. */
  | { kind: "row"; created: boolean };

/** Spec F: the row of a new identity whose address no row uses. */
async function createIdentity(
  strapi: ExchangeHost,
  claims: EntraIdClaims,
  me: GraphMe | null,
  email: string,
  resolution: RoleResolution,
  settings: EntraConfig,
  audit: Audit,
): Promise<CreateOutcome> {
  const users = strapi.db.query(USER_UID);
  const decision = decideRoleWrite(null, resolution, settings.syncMode);
  audit.role = decision.audit;
  if (decision.kind === "reject") {
    audit.result = decision.status === 403 ? "denied" : "unavailable";
    return { kind: "refused", status: decision.status, error: decision.error };
  }
  if (decision.kind !== "create")
    throw new Error(`unexpected role decision ${decision.kind} for a new user`);
  const roleId = await roleIdOf(strapi, decision.role);
  if (roleId === null) {
    strapi.log.error(`[entra] role ${decision.role} does not exist; refusing the sign-in`);
    audit.result = "unavailable";
    return { kind: "refused", status: 503, error: "unavailable" };
  }
  const scalars = me ? buildProfileUpdate(me) : null;
  try {
    // One transaction: db.query create() inserts the row and links its role
    // in two separate commits (@strapi/database entity-manager create), and a
    // concurrent exchange reading between them would see roleSource 'entra'
    // and entraAppliedRole without a role, i.e. an admin's change. The
    // entity manager's own transaction() joins this one, so both commit
    // together. The unique-violation handling below runs after the rollback.
    await strapi.db.transaction(() =>
      users.create({
        data: {
          username: `entra-${claims.oid}`,
          email,
          provider: "microsoft",
          confirmed: true,
          blocked: false,
          role: roleId,
          roleSource: "entra",
          entraAppliedRole: decision.role,
          entraTenantId: claims.tid,
          microsoftOid: claims.oid,
          ...(scalars ?? {}),
          displayName: scalars?.displayName ?? claims.name ?? email,
        },
      }),
    );
    return { kind: "row", created: true };
  } catch (err) {
    // A concurrent first sign-in of the same person won the unique index.
    const winner = await users.findOne({
      where: { entraTenantId: claims.tid, microsoftOid: claims.oid },
      select: ["id"],
    });
    if (!winner) throw err;
    strapi.log.info(
      `[entra] concurrent first sign-in (oid=${audit.oid}): continuing with the existing row`,
    );
    return { kind: "row", created: false };
  }
}

type RoleStep =
  | { kind: "ok"; audit: string }
  | { kind: "refused"; status: 403 | 503; error: ExchangeError; audit: string };

/**
 * Spec I for an existing user: the role decision and its write in ONE short
 * transaction, decided on a fresh read of the row, which is locked on
 * Postgres (FOR UPDATE; SQLite runs every transaction on its single
 * connection, one at a time). db.query update() commits a row's columns and
 * its relations separately, and create() inserts before it links the role:
 * a decision on a read outside the lock could see a concurrent exchange's
 * new entraAppliedRole next to the old role (or none) and take that for an
 * admin's change, flipping the user to manual for good. Not optional: a
 * role Entra no longer grants must not survive a failed write, so a failure
 * here fails the sign-in (503 via the controller).
 */
async function writeRole(
  strapi: ExchangeHost,
  userId: number,
  resolution: RoleResolution,
  mode: EntraConfig["syncMode"],
): Promise<RoleStep> {
  return strapi.db.transaction(async () => {
    if (strapi.db.dialect.client === "postgres") {
      await strapi.db
        .queryBuilder(USER_UID)
        .select(["id"])
        .where({ id: userId })
        .forUpdate()
        .execute();
    }
    const users = strapi.db.query(USER_UID);
    const row = await users.findOne({
      where: { id: userId },
      select: ["id", "roleSource", "entraAppliedRole"],
      populate: { role: { select: ["id", "type"] } },
    });
    if (!row) throw new Error("the user row vanished during the sign-in");
    const decision = decideRoleWrite(
      {
        roleType: isRecord(row.role) ? stringOf(row.role.type) : null,
        roleSource: stringOf(row.roleSource),
        entraAppliedRole: stringOf(row.entraAppliedRole),
      },
      resolution,
      mode,
    );
    if (decision.kind === "reject") {
      return {
        kind: "refused",
        status: decision.status,
        error: decision.error,
        audit: decision.audit,
      };
    }
    if (decision.kind === "update") {
      const data: Record<string, unknown> = { ...decision.data };
      if (decision.data.role !== undefined) {
        const roleId = await roleIdOf(strapi, decision.data.role);
        if (roleId === null) {
          strapi.log.error(
            `[entra] role ${decision.data.role} does not exist; refusing the sign-in`,
          );
          return { kind: "refused", status: 503, error: "unavailable", audit: decision.audit };
        }
        data.role = roleId;
      }
      await users.update({ where: { id: userId }, data });
    }
    return { kind: "ok", audit: decision.audit };
  });
}

async function roleIdOf(strapi: ExchangeHost, type: string): Promise<number | null> {
  const role = await strapi.db.query(ROLE_UID).findOne({ where: { type }, select: ["id"] });
  return role ? role.id : null;
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
    strapi.log.error(`[entra] user=${user.id}: e-mail check failed: ${(err as Error).message}`);
  }
  try {
    await users.update({ where: { id: user.id }, data });
  } catch (err) {
    strapi.log.error(`[entra] user=${user.id}: profile sync failed: ${(err as Error).message}`);
  }
}

/** ENTRA_SYNC_DEPARTMENT=1. Returns the audit value. */
async function syncDepartment(
  strapi: ExchangeHost,
  user: Row,
  me: GraphMe | null,
  mayWrite: boolean,
): Promise<string> {
  if (!me) return "unknown";
  try {
    const name = departmentName(me);
    const matches =
      name === null
        ? []
        : await strapi.documents(DEPARTMENT_UID).findMany({
            filters: { name: { $eqi: name } },
            status: "published",
            fields: ["documentId"],
          });
    const target = pickDepartment(name, matches);
    if (target.kind === "clear" && target.reason !== "empty") {
      strapi.log.warn(
        `[entra] user=${user.id}: the Entra department matches ${target.reason === "no-match" ? "no" : "more than one"} published department; clearing it`,
      );
    }
    const next = target.kind === "set" ? target.documentId : null;
    const current = relationDocumentId(user.department);
    if (next === current) return "unchanged";
    const verb = next === null ? "clear" : "set";
    if (!mayWrite) return `would ${verb}`;
    const documentId = stringOf(user.documentId);
    if (documentId === null) throw new Error("the user has no documentId");
    // By documentId, like the admin panel: the link targets the document.
    await strapi.documents(USER_UID).update({ documentId, data: { department: next } });
    return verb === "set" ? "set" : "cleared";
  } catch (err) {
    strapi.log.error(`[entra] user=${user.id}: department sync failed: ${(err as Error).message}`);
    return "failed";
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
    strapi.log.error(`[entra] user=${user.id}: manager sync failed: ${(err as Error).message}`);
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
    strapi.log.error(
      `[entra] user=${user.id}: manager back-fill failed: ${(err as Error).message}`,
    );
  }
  return outcome;
}
