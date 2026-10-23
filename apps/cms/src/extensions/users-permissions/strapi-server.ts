/**
 * A password change revokes the user's older JWTs (FX40, owner default:
 * a token version on the legacy JWTs).
 *
 * users-permissions runs in `jwtManagement: 'legacy-support'` (the plugin's
 * default, which config/plugins.ts pins explicitly): its JWTs are plain
 * signed tokens, valid until `exp`, and nothing on the server could end one
 * earlier. Now:
 *
 *  - the user has a private, non-searchable integer `tokenVersion`
 *    (content-types/user/schema.json, default 0), hidden from the admin
 *    panel (`visible: false`: no field in the edit view, none in the admin
 *    roles' field permissions). No input can write it: the Document
 *    Service guard below drops it from every create/update/clone of a
 *    user (the Content Manager, PUT /api/users/:id, register, seeds), so
 *    only the atomic bump changes it and it never goes down;
 *  - every JWT the plugin issues carries the user's current version in the
 *    claim `tv` (TOKEN_VERSION_CLAIM);
 *  - every JWT the plugin verifies must carry the user's current version: a
 *    JWT without the claim counts as version 0, so the JWTs issued before
 *    this change stay valid for every user whose version is 0 (all of them,
 *    until they change their password) and nobody is signed out by the
 *    deploy. A mismatch fails verification like a bad signature: the
 *    request is unauthenticated (401);
 *  - a password change raises the version and saves the new password in
 *    ONE database transaction: the plugin saves every password through its
 *    `user` service's edit(), and the wrapped edit() opens a transaction
 *    (strapi.db.transaction), bumps (one atomic statement,
 *    bumpTokenVersion) and lets the plugin write inside it; the Document
 *    Service and the query engine join it through Strapi's transaction
 *    context (AsyncLocalStorage), and the new password's bcrypt hash
 *    (hashSync in the Document Service's attribute transforms) runs in it.
 *    Nobody ever sees the new version next to the old password: a sign-in
 *    reads the version before the hash (signInTokenVersion), so it sees
 *    either both old (Postgres READ COMMITTED, before the commit; its JWT
 *    carries the old version, revoked by the commit) or both new; on
 *    SQLite every other statement waits for the transaction's connection.
 *    Overlapping changes of one user serialise on the row (Postgres) or
 *    the connection (SQLite), so the stored password always belongs to the
 *    change with the highest version. Fail closed: a failed bump or a
 *    failed write (or a process that dies in between) rolls both back,
 *    nothing changed; a new password never stands next to older JWTs that
 *    still work. That covers
 *    POST /api/auth/change-password, /api/auth/reset-password (which the
 *    permission bootstrap revokes for `public`, should an operator grant
 *    it again) and PUT /api/users/:id with a password (no role has
 *    user.update);
 *  - a password the admin panel sets (the Content Manager's user update,
 *    and any other Document Service update of a user whose data carries a
 *    password) is revoked the same way: the Document Service guard
 *    (createUserWriteGuard, registered in src/index.ts register()) runs the
 *    bump and the write in one transaction, like edit(). A write that
 *    edit() itself makes inside its own transaction (passwordSave, an
 *    AsyncLocalStorage) is not bumped a second time;
 *  - the password actions answer with a JWT of exactly the version their
 *    bump committed (its snapshot, not a later read: an overlapping change
 *    of the same user may have raised it again meanwhile, and that JWT must
 *    not go to this tab). The web stores it in the session of the tab that
 *    changed the password (apps/web/src/lib/profile-actions.ts); every
 *    other session of the user gets 401 on its next request and lands on
 *    /sign-in?expired=1. Each change logs
 *    `[auth] password changed: user=<id> tokenVersion=<n>` once saved.
 *
 * A sign-in stamps the version the user had BEFORE the plugin checked the
 * password: the wrapped `callback` (local provider) reads it first, with
 * the plugin's own identifier lookup, and issue() takes it for that user
 * (knownVersion, an AsyncLocalStorage). The plugin reads the hash, runs
 * bcrypt and only then calls issue(); reading the version in issue() gave a
 * login with the OLD password, whose hash read came before a concurrent
 * change, a JWT of the NEW version that the change could not revoke. Now
 * such a JWT carries the old version, which the change has revoked.
 *
 * Entra sign-ins (POST /api/auth/entra/exchange, src/entra/provision.ts)
 * issue through the same service and await it, so their JWTs carry the
 * version too; their lifetime stays ENTRA_SESSION_TTL.
 *
 * The extra reads: verify() looks up the user's version, one primary-key
 * query per authenticated request (the strategy loads the user again right
 * after; the two are not merged, to keep the plugin's own code untouched),
 * and a local sign-in reads it once before the password check.
 *
 * How it hooks in: the Strapi v5 plugin extension pattern
 * (`export default (plugin) => plugin`, like extensions/upload): the
 * `jwt` and `user` services and the `auth` controller are factories, so
 * their factories are WRAPPED and the instances they return are patched;
 * nothing is assigned onto a factory (that would be inert, roadmap FX16).
 *  - The service's `issue` becomes asynchronous in legacy mode (it must read
 *    the version first). The plugin's own controllers put its result into
 *    `ctx.body.jwt` without awaiting it, so every action of the wrapped
 *    auth controller settles a pending `jwt` before it returns. The Entra
 *    exchange already awaits it (refresh mode returns a promise too).
 *  - `verify` runs the plugin's own check first (signature, expiry), then
 *    the version check; getToken() calls it through `this`, so the patched
 *    instance method is the one the users-permissions strategy uses.
 *  - The user service's `edit` bumps and writes a password in one
 *    transaction. The password actions run in an AsyncLocalStorage context
 *    (passwordChange) in which edit() leaves the version its transaction
 *    committed for the issue() that the plugin calls next. Should an upgraded plugin answer a password
 *    action without going through edit(), the wrapper revokes afterwards,
 *    as before, and logs that tripwire as an error.
 *
 * With `jwtManagement: 'refresh'` the plugin revokes sessions itself (its
 * session manager; a password change invalidates the refresh tokens), and
 * every wrapper here passes through untouched. Switching to it is a
 * separate decision (D-SESSION-01 and D-ENTRA-01 lifetimes).
 *
 * Upgrade tripwire: the factories, the service methods (jwt issue/verify,
 * user edit), the sign-in action and the two password actions are asserted
 * at plugin load and at instantiation (still during boot); a Strapi upgrade
 * that changes them fails the boot instead of silently dropping the
 * revocation.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { errors } from "@strapi/utils";

import {
  consumeSecondFactor,
  isEnrolled,
  mfaRequiredRoles,
  recordMfaGate,
  requiredMfa,
  type MfaHost,
} from "../../utils/mfa-core";
import { passwordProblem } from "../../utils/password-rule";

export const USER_UID = "plugin::users-permissions.user";

/** The JWT claim that carries the user's token version. */
export const TOKEN_VERSION_CLAIM = "tv";

/**
 * v0.27 (plan-v027-rev2.md): how the session was authenticated, stamped by
 * issue() from the ISSUING request's context only (withIssueClaims), never
 * from the row: `am` "pw" (local password) or "idp" (Entra/OIDC exchange),
 * `mfa` 1 after a verified second factor. A JWT issued outside such a
 * context carries neither, and the per-request gate treats it as issued
 * before v0.27.
 */
export const AUTH_METHOD_CLAIM = "am";
export const MFA_CLAIM = "mfa";

export interface IssueClaims {
  /** The user the claims belong to; another user's issue() gets none. */
  userId?: number;
  am: "pw" | "idp";
  mfa?: 1;
}

/** What the verified JWT of this request said (the strategy decorator reads it). */
export interface RequestAssurance {
  am: "pw" | "idp" | null;
  mfa: boolean;
  /** The token version the request's JWT carries (rev3: stale-assurance checks). */
  tv: number;
  /** A required second factor is not enrolled yet: only enrollment routes answer. */
  restricted: boolean;
}

/** Marks a wrapped factory, so a second load of the same plugin module does not wrap twice. */
const WRAPPED = Symbol.for("sinnlos.users-permissions.token-version");

/**
 * One AsyncLocalStorage per name for the whole process. Strapi loads this
 * file as the plugin extension, and src/index.ts imports it for the
 * Document Service guard; when the two resolve to different paths (the
 * integration harness's build dir under a Windows 8.3 short name) they are
 * two module instances, and a context set by one must still be seen by the
 * other.
 */
function sharedStorage<T>(name: string): AsyncLocalStorage<T> {
  return sharedSlot(name, () => new AsyncLocalStorage<T>());
}

/** One value per name for the whole process (see sharedStorage). */
function sharedSlot<T>(name: string, create: () => T): T {
  const key = Symbol.for(`sinnlos.users-permissions.${name}`);
  const slots = globalThis as unknown as Record<symbol, T | undefined>;
  return (slots[key] ??= create());
}

/** What runs one raw statement: knex, or a knex transaction. */
export interface RawRunner {
  raw(sql: string, bindings: readonly unknown[]): PromiseLike<unknown>;
}

/** The slice of the Strapi instance the wrappers use. */
export interface TokenVersionStrapi {
  config: { get(path: string, fallback?: unknown): unknown };
  db: {
    query(uid: string): {
      findOne(args: Record<string, unknown>): Promise<unknown>;
    };
    /** knex: the version bump is one raw statement (bumpTokenVersion). */
    connection: RawRunner;
    /** Whether an ambient transaction runs (Strapi's transaction context). */
    inTransaction(): boolean;
    /**
     * Runs `callback` in a transaction, or in the ambient one (Strapi 5:
     * nested calls join, only the outermost commits or rolls back).
     */
    transaction<T>(callback: (scope: { trx: RawRunner }) => Promise<T>): Promise<T>;
    dialect: { client: string };
    getSchemaName(): string | undefined | null;
    metadata: {
      get(uid: string): {
        tableName: string;
        attributes: Record<string, { columnName?: string } | undefined>;
      };
    };
  };
  plugin(name: string): { service(name: string): unknown };
  log?: {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
}

type Factory = (deps: { strapi: TokenVersionStrapi }) => unknown;

type JwtIssue = (this: unknown, payload: unknown, options?: unknown) => unknown;
type JwtVerify = (this: unknown, token: string) => Promise<unknown>;
type JwtGetToken = (this: unknown, ctx: object) => Promise<unknown>;

export interface JwtService extends Record<string, unknown> {
  issue: JwtIssue;
  verify: JwtVerify;
  getToken?: JwtGetToken;
}

type UserEdit = (this: unknown, userId: unknown, params?: unknown, ...rest: unknown[]) => unknown;

/** The users-permissions `user` service: edit() is where the plugin saves a password. */
export interface UserService extends Record<string, unknown> {
  edit: UserEdit;
}

/** The slice of the Koa context the controller wrappers read and write. */
export interface AuthContext {
  body?: unknown;
  state?: { user?: { id?: unknown } | null; assurance?: RequestAssurance };
  params?: { provider?: unknown };
  request?: { body?: unknown };
}

type Action = (this: unknown, ctx: AuthContext, ...rest: unknown[]) => unknown;

export interface UsersPermissionsPlugin {
  services: Record<string, unknown>;
  controllers: Record<string, unknown>;
  register?: unknown;
}

/** The auth actions the wrapper changes beyond settling the JWT. */
export const PASSWORD_ACTIONS = ["changePassword"] as const;

/**
 * The plugin's own e-mail reset flow and provider connect, answered with
 * 404 whatever the grants say (v0.27): the reset would hand any account a
 * password without the provider, version and expiry checks of POST
 * /api/auth/password/set, and no provider but local signs anyone in.
 */
export const DISABLED_AUTH_ACTIONS = ["forgotPassword", "resetPassword", "connect"] as const;

/** The sign-in action, whose version is read before its password check. */
export const SIGN_IN_ACTION = "callback";

/** A version read for one user, carried to issue() of the same request. */
export interface VersionSnapshot {
  userId: number;
  version: number;
}

/**
 * A version this request already holds for one user, which issue() stamps
 * for that user instead of reading the current one: a sign-in's read
 * before its password check, a password change's committed bump
 * (patchAuthController).
 */
const knownVersion = sharedStorage<VersionSnapshot>("known-version");

/** A password action in progress: the version its edit() committed, once it did. */
interface PasswordChange {
  committed: VersionSnapshot | null;
}

/** Set around a password action (patchAuthController), filled by the user service's edit(). */
const passwordChange = sharedStorage<PasswordChange>("password-change");

/** The claims issue() stamps in this context (withIssueClaims). */
const issueClaims = sharedStorage<IssueClaims>("issue-claims");

/**
 * The payload getToken() verified for a request (keyed by its Koa
 * context), for the strategy decorator; private to this module.
 */
const verifiedPayloads = sharedSlot("verified-payloads", () => new WeakMap<object, unknown>());

/**
 * A password action's expectation (rev3 #1): its bump must raise exactly
 * the version the request's JWT was verified at, else another change came
 * in between and the session is out of date.
 */
const expectedBump = sharedStorage<{ userId: number; tv: number }>("expected-bump");

/** Runs `fn` so that the JWTs it issues for `claims.userId` carry `am`/`mfa`. */
export function withIssueClaims<T>(claims: IssueClaims, fn: () => T): T {
  return issueClaims.run(claims, fn);
}

/**
 * A JWT for `userId` at the token version a write of this request committed
 * (`version`, never a later read), with `claims` (utils/mfa.ts: activation
 * and disable).
 */
export async function issueJwtWithClaims(
  strapi: TokenVersionStrapi,
  userId: number,
  version: number,
  claims: Omit<IssueClaims, "userId">,
): Promise<string> {
  const jwt = strapi.plugin("users-permissions").service("jwt") as JwtService;
  const issued = await knownVersion.run({ userId, version }, () =>
    issueClaims.run({ ...claims, userId }, () => jwt.issue({ id: userId })),
  );
  if (typeof issued !== "string") throw new Error("[auth] the jwt service issued no token");
  return issued;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** A numeric user id, from a number or a string of digits; else null. */
function userIdOf(value: unknown): number | null {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A stored or claimed version: a non-negative integer, anything else is 0. */
export function versionOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The version a verified JWT payload carries (0 without the claim). */
export function claimedVersion(payload: unknown): number {
  return isRecord(payload) ? versionOf(payload[TOKEN_VERSION_CLAIM]) : 0;
}

function refreshMode(strapi: TokenVersionStrapi): boolean {
  return (
    strapi.config.get("plugin::users-permissions.jwtManagement", "legacy-support") === "refresh"
  );
}

/** The user's current version, or null when there is no such user. */
export async function currentTokenVersion(
  strapi: TokenVersionStrapi,
  userId: number,
): Promise<number | null> {
  const row = await strapi.db
    .query(USER_UID)
    .findOne({ where: { id: userId }, select: ["id", "tokenVersion"] });
  return isRecord(row) ? versionOf(row.tokenVersion) : null;
}

/**
 * The version of the user a local sign-in names, read the way the plugin's
 * `callback` finds that user (provider 'local', the identifier as the
 * lower-cased email or as the username), before the plugin reads the
 * password hash. null for another provider, a body without an identifier
 * or no such user: the plugin refuses those itself.
 */
export async function signInTokenVersion(
  strapi: TokenVersionStrapi,
  ctx: AuthContext,
): Promise<VersionSnapshot | null> {
  const provider: unknown = ctx.params?.provider || "local";
  if (provider !== "local") return null;
  const body = ctx.request?.body;
  const identifier = isRecord(body) ? body.identifier : undefined;
  if (typeof identifier !== "string" || identifier === "") return null;
  const row = await strapi.db.query(USER_UID).findOne({
    where: {
      provider: "local",
      $or: [{ email: identifier.toLowerCase() }, { username: identifier }],
    },
    select: ["id", "tokenVersion"],
  });
  if (!isRecord(row)) return null;
  const userId = userIdOf(row.id);
  return userId === null ? null : { userId, version: versionOf(row.tokenVersion) };
}

/** Where the version lives: the user table and its columns, from Strapi's metadata. */
export interface TokenVersionTarget {
  client: string;
  /** Postgres schema (DATABASE_SCHEMA); ignored on SQLite. */
  schema: string;
  table: string;
  idColumn: string;
  versionColumn: string;
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/**
 * The bump as ONE statement that also returns the new value: the database
 * serialises it per row, so overlapping changes of one user each get their
 * own version and the stored version only ever grows. (Read, then write
 * the read value + 1 let a change that read early overwrite a later one's
 * higher version with a lower one, which made JWTs that the later change
 * had revoked valid again.) A stored NULL counts as 0. Postgres and SQLite
 * (>= 3.35, RETURNING; better-sqlite3 12.9.0 bundles 3.53.0); the bound id
 * is knex's `?`.
 */
export function tokenVersionBumpSql(target: TokenVersionTarget): string {
  const version = quote(target.versionColumn);
  const set = `SET ${version} = COALESCE(${version}, 0) + 1 WHERE ${quote(target.idColumn)} = ? RETURNING ${version}`;
  if (target.client === "postgres") {
    return `UPDATE ${quote(target.schema)}.${quote(target.table)} ${set}`;
  }
  if (target.client === "sqlite") return `UPDATE ${quote(target.table)} ${set}`;
  throw new Error(
    `[users-permissions-extension] database client ${target.client} is not supported (Postgres or SQLite); ` +
      "the token version cannot be raised (FX40).",
  );
}

function tokenVersionTarget(strapi: TokenVersionStrapi): TokenVersionTarget {
  const meta = strapi.db.metadata.get(USER_UID);
  const column = (attribute: string, fallback: string) =>
    meta.attributes[attribute]?.columnName ?? fallback;
  return {
    client: strapi.db.dialect.client,
    schema: strapi.db.getSchemaName() || "public",
    table: meta.tableName,
    idColumn: column("id", "id"),
    versionColumn: column("tokenVersion", "token_version"),
  };
}

/** The value a RETURNING statement gave back (pg: `{ rows }`, better-sqlite3: the rows). */
function returnedVersion(result: unknown, column: string): number | null {
  const rows = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.rows)
      ? result.rows
      : [];
  const row: unknown = rows[0];
  if (!isRecord(row)) return null;
  const value = row[column];
  const version = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof version === "number" && Number.isSafeInteger(version) && version > 0
    ? version
    : null;
}

/**
 * Raises the user's version by one, atomically (tokenVersionBumpSql), and
 * returns the version this call committed. Throws when the database
 * returned no row (no such user), so a caller never goes on as if the
 * older JWTs were revoked. Inside an ambient transaction (a write that
 * already holds one) the statement joins it: on SQLite the base
 * connection is the transaction's only connection, and a statement next
 * to it would wait for it forever; joined, the bump commits or rolls back
 * with the password write.
 */
export async function bumpTokenVersion(
  strapi: TokenVersionStrapi,
  userId: number,
): Promise<number> {
  const target = tokenVersionTarget(strapi);
  const sql = tokenVersionBumpSql(target);
  const { db } = strapi;
  const result = db.inTransaction()
    ? await db.transaction(async ({ trx }) => trx.raw(sql, [userId]))
    : await db.connection.raw(sql, [userId]);
  const version = returnedVersion(result, target.versionColumn);
  if (version === null) {
    throw new Error(
      `[users-permissions-extension] the token version of user ${userId} was not raised (no such user)`,
    );
  }
  return version;
}

function assertJwtService(service: unknown): asserts service is JwtService {
  if (
    !isRecord(service) ||
    typeof service.issue !== "function" ||
    typeof service.verify !== "function"
  ) {
    throw new Error(
      "[users-permissions-extension] the jwt service no longer exposes issue() and verify(); " +
        "password-change revocation would be off — review extensions/users-permissions/strapi-server.ts " +
        "against this Strapi version before booting (FX40 tripwire).",
    );
  }
}

function assertUserService(service: unknown): asserts service is UserService {
  if (!isRecord(service) || typeof service.edit !== "function") {
    throw new Error(
      "[users-permissions-extension] the user service no longer exposes edit(); " +
        "password-change revocation would be off — review extensions/users-permissions/strapi-server.ts " +
        "against this Strapi version before booting (FX40 tripwire).",
    );
  }
}

function assertAuthController(controller: unknown): asserts controller is Record<string, unknown> {
  const actions = [...PASSWORD_ACTIONS, SIGN_IN_ACTION];
  const missing = isRecord(controller)
    ? actions.filter((action) => typeof controller[action] !== "function")
    : actions;
  if (missing.length > 0) {
    throw new Error(
      `[users-permissions-extension] the auth controller no longer exposes ${missing.join(", ")}; ` +
        "password-change revocation would be off (FX40 tripwire).",
    );
  }
}

function assertStrapi(strapi: unknown): asserts strapi is TokenVersionStrapi {
  const db = isRecord(strapi) ? strapi.db : undefined;
  const ok =
    isRecord(strapi) &&
    isRecord(strapi.config) &&
    typeof strapi.config.get === "function" &&
    isRecord(db) &&
    typeof db.query === "function" &&
    (typeof db.connection === "function" || isRecord(db.connection)) &&
    typeof (db.connection as { raw?: unknown }).raw === "function" &&
    isRecord(db.dialect) &&
    typeof db.getSchemaName === "function" &&
    typeof db.transaction === "function" &&
    typeof db.inTransaction === "function" &&
    isRecord(db.metadata) &&
    typeof db.metadata.get === "function" &&
    typeof strapi.plugin === "function";
  if (!ok) {
    throw new Error(
      "[users-permissions-extension] a factory did not receive { strapi } with config, plugin and a db " +
        "with query/connection/dialect/getSchemaName/transaction/inTransaction/metadata (FX40 tripwire).",
    );
  }
}

/**
 * Patches a jwt service instance: issue() stamps the version (the
 * request's known version for its own user, else the current one),
 * verify() checks it.
 */
export function patchJwtService(service: JwtService, strapi: TokenVersionStrapi): JwtService {
  const originalIssue = service.issue;
  const originalVerify = service.verify;

  service.issue = function issue(this: unknown, payload: unknown, options?: unknown) {
    if (refreshMode(strapi)) return originalIssue.call(this, payload, options);
    const plain =
      isRecord(payload) && typeof payload.toJSON === "function"
        ? (payload.toJSON as () => unknown)()
        : payload;
    const userId = isRecord(plain) ? userIdOf(plain.id) : null;
    // Read now, in the caller's context: the request's known version (a
    // sign-in's, or the bump of the password action this issue() answers).
    const snapshot = knownVersion.getStore() ?? passwordChange.getStore()?.committed ?? undefined;
    const claims = issueClaims.getStore();
    const assurance =
      claims && userId !== null && (claims.userId === undefined || claims.userId === userId)
        ? { [AUTH_METHOD_CLAIM]: claims.am, ...(claims.mfa === 1 ? { [MFA_CLAIM]: 1 } : {}) }
        : {};
    const pending = (async () => {
      const version =
        userId === null
          ? null
          : snapshot?.userId === userId
            ? snapshot.version
            : await currentTokenVersion(strapi, userId);
      const stamped =
        version === null || !isRecord(plain)
          ? plain
          : { ...plain, ...assurance, [TOKEN_VERSION_CLAIM]: version };
      return originalIssue.call(this, stamped, options);
    })();
    // Awaited by the caller (the settled ctx.body.jwt, the Entra exchange);
    // this only keeps a rejection from counting as unhandled before that.
    pending.catch(() => undefined);
    return pending;
  };

  service.verify = async function verify(this: unknown, token: string) {
    const payload = await originalVerify.call(this, token);
    if (refreshMode(strapi) || !isRecord(payload)) return payload;
    const userId = userIdOf(payload.id);
    // No usable id: the strategy refuses the token itself.
    if (userId === null) return payload;
    const current = await currentTokenVersion(strapi, userId);
    // No such user: the strategy answers "Invalid credentials" itself.
    if (current !== null && claimedVersion(payload) !== current) {
      throw new Error("Invalid token.");
    }
    return payload;
  };

  // v0.27: keep what the users-permissions strategy verified, for its
  // decorator. Without getToken (an upgraded plugin) the gate sees no
  // claims and asks every user who needs a second factor to sign in again.
  const originalGetToken = service.getToken;
  if (typeof originalGetToken === "function") {
    service.getToken = async function getToken(this: unknown, ctx: object) {
      const payload = await originalGetToken.call(this, ctx);
      if (ctx && typeof ctx === "object" && payload) verifiedPayloads.set(ctx, payload);
      return payload;
    };
  }

  return service;
}

/** An edit() that writes a password (any value but undefined: clearing one counts too). */
function setsPassword(params: unknown): boolean {
  return isRecord(params) && params.password !== undefined;
}

/** The user whose password is being saved inside its bump's transaction (saveAfterBump). */
const passwordSave = sharedStorage<{ userId: number }>("password-save");

/**
 * The users with a bump-and-save running, per transaction (the trx object
 * Strapi hands every nested call of one transaction). Two of them for the
 * same user inside ONE transaction share its row lock, so nothing orders
 * them: A bumps to 1, B bumps to 2 and saves, A saves; A's password would
 * stand with B's JWT accepted. The second one is refused (saveAfterBump).
 */
const passwordChangesInFlight = sharedSlot(
  "password-changes-in-flight",
  () => new WeakMap<object, Set<number>>(),
);

/**
 * Raises user `id`'s version and runs `save` (the password write) in ONE
 * transaction, joining an ambient one (strapi.db.transaction): both commit
 * together or neither does. A failed bump or save rolls both back, so the
 * password and the user's sessions stay as they were. Only once it has
 * committed does a password action's issue() get the version
 * (passwordChange); during `save` passwordSave names the user, so the
 * Document Service guard does not bump the same write again.
 *
 * Separate transactions are ordered by the bump's row lock (Postgres) or
 * the one connection (SQLite). Inside one shared transaction they are not:
 * a second bump-and-save of the same user while the first still runs
 * there is refused before it writes anything (fail closed, never a wait:
 * the first could be waiting on the second, e.g. a save that changes the
 * same user's password again, and that would deadlock). No request path
 * does this today; each request has its own transaction.
 */
async function saveAfterBump<T>(
  strapi: TokenVersionStrapi,
  id: number,
  save: () => Promise<T>,
): Promise<T> {
  let outcome: { version: number; result: T };
  try {
    outcome = await strapi.db.transaction(async ({ trx }) => {
      let running = passwordChangesInFlight.get(trx);
      if (!running) {
        running = new Set();
        passwordChangesInFlight.set(trx, running);
      }
      if (running.has(id)) {
        throw new Error(
          `[users-permissions-extension] a second password change of user ${id} inside the same ` +
            "transaction, while the first is still running, is refused (FX40).",
        );
      }
      running.add(id);
      try {
        const version = await bumpTokenVersion(strapi, id);
        const expected = expectedBump.getStore();
        if (expected?.userId === id && version !== expected.tv + 1) {
          throw new errors.UnauthorizedError("The session is out of date; sign in again");
        }
        const result = await passwordSave.run({ userId: id }, save);
        return { version, result };
      } finally {
        running.delete(id);
      }
    });
  } catch (error) {
    strapi.log?.warn?.(
      `[auth] password not changed: user=${id} ` +
        "(the change rolled back: the password and the user's sessions are as they were)",
    );
    throw error;
  }
  const change = passwordChange.getStore();
  if (change) change.committed = { userId: id, version: outcome.version };
  strapi.log?.info?.(`[auth] password changed: user=${id} tokenVersion=${outcome.version}`);
  return outcome.result;
}

/**
 * Patches a user service instance: an edit() that writes a password raises
 * the user's version (bumpTokenVersion) and lets the plugin save the
 * password in one transaction (saveAfterBump): both or neither. In a
 * password action the committed version goes to the action's issue()
 * (passwordChange).
 */
export function patchUserService(service: UserService, strapi: TokenVersionStrapi): UserService {
  const originalEdit = service.edit;

  service.edit = async function edit(
    this: unknown,
    userId: unknown,
    params?: unknown,
    ...rest: unknown[]
  ) {
    if (refreshMode(strapi) || !setsPassword(params)) {
      return originalEdit.call(this, userId, params, ...rest);
    }
    const id = userIdOf(userId);
    if (id === null) {
      throw new Error(
        "[users-permissions-extension] a password change for a user without a numeric id is refused: " +
          "its older JWTs could not be revoked (FX40).",
      );
    }
    return saveAfterBump(strapi, id, async () => originalEdit.call(this, userId, params, ...rest));
  };

  return service;
}

/** The attribute the guard keeps out of every write: only the bump sets it. */
export const TOKEN_VERSION_ATTRIBUTE = "tokenVersion";

/**
 * The second factor's state (v0.27): written only by utils/mfa.ts through
 * the query engine, never by a Document Service write (the Content Manager,
 * PUT /api/users/:id, user.add/edit, seeds).
 */
export const MFA_ATTRIBUTES = ["totpSecret", "totpEnabledAt", "totpLastStep", "totpRecoveryCodes"];

/** What the guard drops from every user write. */
const GUARDED_ATTRIBUTES = [TOKEN_VERSION_ATTRIBUTE, ...MFA_ATTRIBUTES];

/**
 * The password baseline (v0.27, utils/password-rule.ts) for every Document
 * Service write that sets a password: the Content Manager's create and
 * update, users-permissions' add() and edit(), seeds. Throws a 400 whose
 * message is `password_<problem>`.
 */
export function assertPasswordAllowed(password: unknown): void {
  if (typeof password !== "string") return;
  const problem = passwordProblem(password);
  if (problem) {
    throw new errors.ValidationError(`password_${problem}`, { code: `password_${problem}` });
  }
}

/** Document Service actions that write a user's attributes from `params.data`. */
const USER_WRITE_ACTIONS: readonly string[] = ["create", "update", "clone"];

/**
 * What @strapi/core 5.55.1 hands a Document Service middleware
 * (services/document-service/middlewares/middleware-manager.js wrapObject:
 * the action runs with `ctx.params` as it is after the middlewares).
 */
export interface DocumentMiddlewareContext {
  uid?: string;
  action?: string;
  params?: unknown;
}

export type DocumentMiddleware = (
  context: DocumentMiddlewareContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * The Document Service guard of the user type:
 *  - drops `tokenVersion` from the data of every create, update and clone
 *    (and logs it): the Content Manager (where the field is hidden
 *    anyway), PUT /api/users/:id (the user service's edit() passes the
 *    body through), register and POST /api/users (the user service's
 *    add()), seeds. Only bumpTokenVersion, raw SQL outside the Document
 *    Service, writes it, so it never goes down;
 *  - an update whose data carries a password raises the user's version
 *    and runs the write in one transaction (saveAfterBump), unless the
 *    user service's edit() is saving that user's password inside its own
 *    (passwordSave): that is how a password the admin panel sets revokes
 *    the older JWTs.
 * In refresh mode only the drop applies.
 */
export function createUserWriteGuard(strapi: TokenVersionStrapi): DocumentMiddleware {
  return async (context, next) => {
    if (context.uid !== USER_UID || !USER_WRITE_ACTIONS.includes(context.action ?? "")) {
      return next();
    }
    const params = isRecord(context.params) ? context.params : {};
    let data = isRecord(params.data) ? params.data : undefined;
    const guarded = data
      ? GUARDED_ATTRIBUTES.filter((key) => Object.prototype.hasOwnProperty.call(data, key))
      : [];
    if (data && guarded.length > 0) {
      data = Object.fromEntries(Object.entries(data).filter(([key]) => !guarded.includes(key)));
      context.params = { ...params, data };
      strapi.log?.warn?.(
        `[auth] ${guarded.join(", ")} dropped from a Document Service ${context.action} of a user: ` +
          "only the password change and the second-factor flows write them (FX40, v0.27)",
      );
    }
    // Before the update-only return below: creates must meet the baseline too.
    assertPasswordAllowed(data?.password);
    if (context.action !== "update" || !setsPassword(data) || refreshMode(strapi)) return next();
    const documentId = params.documentId;
    const row =
      typeof documentId === "string" && documentId !== ""
        ? await strapi.db.query(USER_UID).findOne({ where: { documentId }, select: ["id"] })
        : null;
    const id = isRecord(row) ? userIdOf(row.id) : null;
    if (id === null) {
      throw new Error(
        "[users-permissions-extension] a password update of a user that cannot be found is refused: " +
          "its older JWTs could not be revoked (FX40).",
      );
    }
    // The user service's edit() bumped for this very save already.
    if (passwordSave.getStore()?.userId === id) return next();
    return saveAfterBump(strapi, id, next);
  };
}

/** register() needs `strapi.documents.use` as well. */
export interface UserWriteGuardHost extends TokenVersionStrapi {
  documents?: { use?(middleware: DocumentMiddleware): unknown };
}

/**
 * Hangs the guard onto the Document Service (src/index.ts register()).
 * Throws when the Document Service has no `use` (a Strapi upgrade moved
 * it): the cms must not run with admin-set passwords that revoke nothing.
 */
export function registerUserWriteGuard(strapi: UserWriteGuardHost): void {
  const documents = strapi.documents;
  if (!documents || typeof documents.use !== "function") {
    throw new Error(
      "[users-permissions-extension] strapi.documents.use not found — refusing to boot without the " +
        "user write guard (admin-panel password revocation, tokenVersion kept out of writes; FX40 tripwire).",
    );
  }
  documents.use(createUserWriteGuard(strapi));
}

/**
 * The routes a restricted session (a required second factor not enrolled
 * yet) may call: its own profile (which says so) and the enrollment.
 * Matched on the resolved route: `<METHOD> <handler>`.
 */
export const RESTRICTED_ROUTES: ReadonlySet<string> = new Set([
  "GET api::profile.profile.me",
  "POST api::profile.profile.mfaSetup",
  "POST api::profile.profile.mfaActivate",
]);

/**
 * The per-request decision (plan-v027-rev2.md, gate table) for an
 * authenticated user: `pass`, `reauth` (401, sign in again) or
 * `restricted` (only RESTRICTED_ROUTES).
 */
export function mfaDecision(
  payload: unknown,
  user: unknown,
  roles: readonly string[],
): "pass" | "reauth" | "restricted" {
  const claims = isRecord(payload) ? payload : {};
  const am = claims[AUTH_METHOD_CLAIM];
  const mfa = claims[MFA_CLAIM];
  // Only what issue() writes: an unknown method or a non-canonical mfa is refused.
  if ((am !== undefined && am !== "pw" && am !== "idp") || (mfa !== undefined && mfa !== 1)) {
    return "reauth";
  }
  if (am === "idp") return "pass";
  const required = requiredMfa(user, roles);
  if (!required) return "pass";
  if (am === "pw") {
    if (mfa === 1) return "pass";
    return isEnrolled(user) ? "reauth" : "restricted";
  }
  // No claim: a JWT from before v0.27 (or issued outside any context).
  return "reauth";
}

/** The users-permissions auth strategy as Strapi's auth service holds it. */
export interface AuthStrategy {
  name?: string;
  authenticate(ctx: StrategyContext): Promise<unknown>;
  verify?(...args: unknown[]): unknown;
}

export interface StrategyContext {
  state: Record<string, unknown> & { route?: { method?: unknown; handler?: unknown } };
}

/**
 * The strategy with the per-request second-factor gate around its
 * successful authentication (after the plugin's user and blocked checks):
 * the verified claims of the request's JWT (verifiedPayload) and the user
 * row the plugin loaded decide (mfaDecision). The outcome is on
 * `ctx.state.assurance` for the routes that need it (/api/me,
 * change-password). A restricted session gets a 403 named MfaSetupRequired
 * with details.code `mfa_setup_required` (a PolicyError, thrown outside the
 * plugin's own catch-all so it is not turned into a generic authentication
 * failure, and passed through by Strapi's authorize step).
 */
export function decorateStrategy(
  strategy: AuthStrategy,
  roles: () => readonly string[] = mfaRequiredRoles,
): AuthStrategy {
  const authenticate = strategy.authenticate.bind(strategy);
  return {
    ...strategy,
    async authenticate(ctx: StrategyContext) {
      const result = await authenticate(ctx);
      if (!isRecord(result) || result.authenticated !== true || !isRecord(result.credentials)) {
        return result;
      }
      const verified = verifiedPayloads.get(ctx);
      const decision = mfaDecision(verified, result.credentials, roles());
      const payload = isRecord(verified) ? verified : {};
      const am = payload[AUTH_METHOD_CLAIM];
      const assurance: RequestAssurance = {
        am: am === "pw" || am === "idp" ? am : null,
        mfa: payload[MFA_CLAIM] === 1,
        tv: claimedVersion(payload),
        restricted: decision === "restricted",
      };
      ctx.state.assurance = assurance;
      if (decision === "pass") return result;
      if (decision === "reauth") return { error: "Invalid credentials" };
      const route = ctx.state.route;
      const key = `${String(route?.method ?? "").toUpperCase()} ${String(route?.handler ?? "")}`;
      if (RESTRICTED_ROUTES.has(key)) return result;
      // A PolicyError (a ForbiddenError: 403): Strapi's authorize step turns
      // any other ForbiddenError into a bare "Forbidden" and drops the code.
      const refused = new errors.PolicyError("A second factor must be set up first", {
        code: "mfa_setup_required",
      });
      (refused as { name: string }).name = "MfaSetupRequired";
      throw refused;
    },
  };
}

/** Marks the decorated strategy, so the boot can assert it is in place. */
const DECORATED = Symbol.for("sinnlos.users-permissions.mfa-gate");

/**
 * Wraps the plugin's register(): while it runs, the auth service's
 * register() swaps the users-permissions content-api strategy for the
 * decorated one. Throws when the plugin registered none (an upgrade moved
 * it): the cms must not run without the gate.
 */
export function wrapPluginRegister(
  register: unknown,
): (deps: { strapi: { get(name: string): unknown } }) => Promise<void> {
  if (typeof register !== "function") {
    throw new Error(
      "[users-permissions-extension] the plugin has no register(); the MFA gate cannot be applied (v0.27 tripwire).",
    );
  }
  if ((register as { [WRAPPED]?: boolean })[WRAPPED]) {
    return register as (deps: { strapi: { get(name: string): unknown } }) => Promise<void>;
  }
  const original = register as (deps: unknown) => unknown;
  const wrapped = async (deps: { strapi: { get(name: string): unknown } }) => {
    const auth = deps.strapi.get("auth") as { register(type: string, strategy: unknown): unknown };
    const registerStrategy = auth.register;
    let decorated = 0;
    auth.register = function (this: unknown, type: string, strategy: unknown) {
      if (type === "content-api" && isRecord(strategy) && strategy.name === "users-permissions") {
        const replacement = decorateStrategy(strategy as unknown as AuthStrategy);
        (replacement as unknown as Record<symbol, boolean>)[DECORATED] = true;
        decorated++;
        return registerStrategy.call(this, type, replacement);
      }
      return registerStrategy.call(this, type, strategy);
    };
    try {
      await original(deps);
    } finally {
      auth.register = registerStrategy;
    }
    recordMfaGate(decorated);
    if (decorated !== 1) {
      throw new Error(
        "[users-permissions-extension] the users-permissions content-api strategy was not registered " +
          "through strapi.get('auth').register(); refusing to boot without the second-factor gate (v0.27 tripwire).",
      );
    }
  };
  (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
  return wrapped;
}

/** The error answer of a refused second factor (POST /api/auth/local). */
function secondFactorRefusal(
  ctx: AuthContext & { status?: number },
  code: "mfa_required" | "mfa_invalid",
): void {
  ctx.status = 401;
  ctx.body = {
    data: null,
    error: {
      status: 401,
      name: "UnauthorizedError",
      message: code === "mfa_required" ? "Second factor required" : "Invalid second factor",
      details: { code },
    },
  };
}

/** Replaces a pending `ctx.body.jwt` (issue() in legacy mode) by the JWT it resolves to. */
export async function settleIssuedJwt(ctx: AuthContext): Promise<void> {
  const body = ctx.body;
  if (isRecord(body) && isThenable(body.jwt)) body.jwt = await body.jwt;
}

/**
 * Patches an auth controller instance: every action settles the JWT it
 * answers with; a local sign-in reads the version before its password
 * check; the password actions run in a passwordChange context, so that
 * their answer carries the version their edit() committed together with
 * the new password.
 */
export function patchAuthController(
  controller: Record<string, unknown>,
  strapi: TokenVersionStrapi,
): Record<string, unknown> {
  const jwtService = () => strapi.plugin("users-permissions").service("jwt") as JwtService;

  /**
   * Runs a password action in a passwordChange context. Its edit() bumped
   * and saved in one transaction, and the JWT of its answer carries that
   * version. A
   * successful answer without such a bump (an upgraded plugin that saves
   * the password some other way) is the tripwire: revoke now, answer with
   * that version, log it as an error.
   */
  const passwordAction = (
    name: string,
    actionUserId: (ctx: AuthContext) => number | null,
  ): void => {
    const original = controller[name] as Action;
    controller[name] = async function (this: unknown, ctx: AuthContext, ...rest: unknown[]) {
      if (refreshMode(strapi)) return original.call(this, ctx, ...rest);
      const change: PasswordChange = { committed: null };
      // v0.27: the new JWT keeps the assurance of the request's verified JWT
      // (never more: the row does not raise it).
      const assurance = ctx.state?.assurance;
      const caller = actionUserId(ctx);
      const claims: IssueClaims | undefined =
        assurance?.am && caller !== null
          ? { userId: caller, am: assurance.am, ...(assurance.mfa ? { mfa: 1 as const } : {}) }
          : undefined;
      const withClaims = <T>(fn: () => T): T => (claims ? issueClaims.run(claims, fn) : fn());
      // rev3 #1: the bump must raise exactly the version this session was
      // verified at (saveAfterBump refuses with 401 otherwise).
      const expectation =
        assurance && caller !== null ? { userId: caller, tv: assurance.tv } : null;
      const run = () =>
        withClaims(() => passwordChange.run(change, () => original.call(this, ctx, ...rest)));
      const result = await (expectation ? expectedBump.run(expectation, run) : run());
      const body = ctx.body;
      // A refused change threw before; no JWT in the answer means no success.
      if (change.committed || !isRecord(body) || typeof body.jwt !== "string") return result;
      const userId = actionUserId(ctx);
      strapi.log?.error?.(
        `[users-permissions-extension] ${name} answered without saving the password through the user ` +
          "service's edit(); its older JWTs are revoked only after the save (FX40 tripwire).",
      );
      if (userId === null) {
        throw new Error(
          `[users-permissions-extension] ${name} answered for no numeric user id; its older JWTs could not be revoked (FX40).`,
        );
      }
      const committed: VersionSnapshot = {
        userId,
        version: await bumpTokenVersion(strapi, userId),
      };
      // The assurance travels only when nothing else changed the version meanwhile.
      const current = !expectation || committed.version === expectation.tv + 1;
      body.jwt = await knownVersion.run(committed, () =>
        current
          ? withClaims(() => jwtService().issue({ id: userId }))
          : jwtService().issue({ id: userId }),
      );
      strapi.log?.info?.(
        `[auth] password changed: user=${userId} tokenVersion=${committed.version}`,
      );
      return result;
    };
  };

  for (const [name, value] of Object.entries(controller)) {
    if (typeof value !== "function") continue;
    const original = value as Action;
    const settles: Action = async function (this: unknown, ctx, ...rest) {
      const result = await original.call(this, ctx, ...rest);
      await settleIssuedJwt(ctx);
      return result;
    };
    controller[name] = settles;
  }

  const signIn = controller[SIGN_IN_ACTION] as Action;
  /**
   * A local sign-in (v0.27): the second factor is checked only after the
   * plugin accepted the password. `otp` (a TOTP or recovery code) leaves the
   * body before the plugin sees it. An enrolled user without a valid,
   * unused code gets 401 `mfa_required`/`mfa_invalid`, and the JWT the
   * plugin issued never leaves the server; with one, the answer carries a
   * new JWT with `mfa: 1`. A user who has not enrolled gets the plugin's JWT
   * with `am: "pw"`; the gate restricts it when a second factor is required.
   */
  controller[SIGN_IN_ACTION] = async function (
    this: unknown,
    ctx: AuthContext,
    ...rest: unknown[]
  ) {
    // rev3 #13: only local sign-in; every plugin provider callback is gone.
    const provider: unknown = ctx.params?.provider || "local";
    if (provider !== "local") throw new errors.NotFoundError("Not Found");
    const body = ctx.request?.body;
    let otp: string | undefined;
    if (isRecord(body) && Object.prototype.hasOwnProperty.call(body, "otp")) {
      otp = typeof body.otp === "string" && body.otp.length <= 64 ? body.otp : "";
      delete body.otp;
    }
    const snapshot = refreshMode(strapi) ? null : await signInTokenVersion(strapi, ctx);
    if (!snapshot) return signIn.call(this, ctx, ...rest);
    const claims: IssueClaims = { userId: snapshot.userId, am: "pw" };
    const result = await knownVersion.run(snapshot, () =>
      issueClaims.run(claims, () => signIn.call(this, ctx, ...rest)),
    );
    const answer = ctx.body;
    if (!isRecord(answer) || typeof answer.jwt !== "string") return result;
    const row = await strapi.db
      .query(USER_UID)
      .findOne({ where: { id: snapshot.userId }, select: ["id", "totpEnabledAt"] });
    if (!isEnrolled(row)) return result;
    if (!otp) {
      secondFactorRefusal(ctx, "mfa_required");
      return result;
    }
    const consumed = await consumeSecondFactor(
      strapi as unknown as MfaHost,
      snapshot.userId,
      snapshot.version,
      otp,
    );
    if (!consumed.ok) {
      secondFactorRefusal(ctx, "mfa_invalid");
      return result;
    }
    answer.jwt = await knownVersion.run(snapshot, () =>
      issueClaims.run({ ...claims, mfa: 1 }, () => jwtService().issue({ id: snapshot.userId })),
    );
    return result;
  };

  passwordAction("changePassword", (ctx) => userIdOf(ctx.state?.user?.id));

  for (const name of DISABLED_AUTH_ACTIONS) {
    controller[name] = async function () {
      throw new errors.NotFoundError("Not Found");
    };
  }

  return controller;
}

/** Wraps `factory` so the instance it returns goes through `patch`. */
function wrapFactory(
  factory: unknown,
  what: string,
  patch: (instance: unknown, strapi: TokenVersionStrapi) => unknown,
): Factory {
  if (typeof factory !== "function") {
    throw new Error(
      `[users-permissions-extension] ${what} is not a factory; password-change revocation cannot be applied (FX40 tripwire).`,
    );
  }
  if ((factory as { [WRAPPED]?: boolean })[WRAPPED]) return factory as Factory;
  const original = factory as Factory;
  const wrapped: Factory = (deps) => {
    const strapi = deps?.strapi;
    assertStrapi(strapi);
    return patch(original(deps), strapi);
  };
  (wrapped as { [WRAPPED]?: boolean })[WRAPPED] = true;
  return wrapped;
}

export function createUsersPermissionsExtension() {
  return (plugin: UsersPermissionsPlugin): UsersPermissionsPlugin => {
    plugin.services.jwt = wrapFactory(plugin?.services?.jwt, "services.jwt", (service, strapi) => {
      assertJwtService(service);
      return patchJwtService(service, strapi);
    });
    plugin.services.user = wrapFactory(
      plugin?.services?.user,
      "services.user",
      (service, strapi) => {
        assertUserService(service);
        return patchUserService(service, strapi);
      },
    );
    plugin.controllers.auth = wrapFactory(
      plugin?.controllers?.auth,
      "controllers.auth",
      (controller, strapi) => {
        assertAuthController(controller);
        return patchAuthController(controller, strapi);
      },
    );
    plugin.register = wrapPluginRegister(plugin.register);
    return plugin;
  };
}

export default createUsersPermissionsExtension();
