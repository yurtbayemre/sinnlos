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
 *    (content-types/user/schema.json, default 0);
 *  - every JWT the plugin issues carries the user's current version in the
 *    claim `tv` (TOKEN_VERSION_CLAIM);
 *  - every JWT the plugin verifies must carry the user's current version: a
 *    JWT without the claim counts as version 0, so the JWTs issued before
 *    this change stay valid for every user whose version is 0 (all of them,
 *    until they change their password) and nobody is signed out by the
 *    deploy. A mismatch fails verification like a bad signature: the
 *    request is unauthenticated (401);
 *  - a password change raises the version BEFORE the new password is
 *    saved: the plugin saves every password through its `user` service's
 *    edit(), and the wrapped edit() bumps first (one atomic statement,
 *    bumpTokenVersion) and only then lets the plugin write. Fail closed:
 *    a failed bump fails the request with the password unchanged; a
 *    failed write after the bump (or a process that dies in between)
 *    leaves the password unchanged and the user's sessions signed out,
 *    never a new password next to older JWTs that still work. That covers
 *    POST /api/auth/change-password, /api/auth/reset-password (which the
 *    permission bootstrap revokes for `public`, should an operator grant
 *    it again) and PUT /api/users/:id with a password (no role has
 *    user.update);
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
 *  - The user service's `edit` bumps before it writes a password. The
 *    password actions run in an AsyncLocalStorage context (passwordChange)
 *    in which edit() leaves the committed version for the issue() that
 *    the plugin calls next. Should an upgraded plugin answer a password
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

export const USER_UID = "plugin::users-permissions.user";

/** The JWT claim that carries the user's token version. */
export const TOKEN_VERSION_CLAIM = "tv";

/** Marks a wrapped factory, so a second load of the same plugin module does not wrap twice. */
const WRAPPED = Symbol.for("sinnlos.users-permissions.token-version");

/** The slice of the Strapi instance the wrappers use. */
export interface TokenVersionStrapi {
  config: { get(path: string, fallback?: unknown): unknown };
  db: {
    query(uid: string): {
      findOne(args: Record<string, unknown>): Promise<unknown>;
    };
    /** knex: the version bump is one raw statement (bumpTokenVersion). */
    connection: { raw(sql: string, bindings: readonly unknown[]): PromiseLike<unknown> };
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

export interface JwtService extends Record<string, unknown> {
  issue: JwtIssue;
  verify: JwtVerify;
}

type UserEdit = (this: unknown, userId: unknown, params?: unknown, ...rest: unknown[]) => unknown;

/** The users-permissions `user` service: edit() is where the plugin saves a password. */
export interface UserService extends Record<string, unknown> {
  edit: UserEdit;
}

/** The slice of the Koa context the controller wrappers read and write. */
export interface AuthContext {
  body?: unknown;
  state?: { user?: { id?: unknown } | null };
  params?: { provider?: unknown };
  request?: { body?: unknown };
}

type Action = (this: unknown, ctx: AuthContext, ...rest: unknown[]) => unknown;

export interface UsersPermissionsPlugin {
  services: Record<string, unknown>;
  controllers: Record<string, unknown>;
}

/** The auth actions the wrapper changes beyond settling the JWT. */
export const PASSWORD_ACTIONS = ["changePassword", "resetPassword"] as const;

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
const knownVersion = new AsyncLocalStorage<VersionSnapshot>();

/** A password action in progress: the version its edit() committed, once it did. */
interface PasswordChange {
  committed: VersionSnapshot | null;
}

/** Set around a password action (patchAuthController), filled by the user service's edit(). */
const passwordChange = new AsyncLocalStorage<PasswordChange>();

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
 * older JWTs were revoked.
 */
export async function bumpTokenVersion(
  strapi: TokenVersionStrapi,
  userId: number,
): Promise<number> {
  const target = tokenVersionTarget(strapi);
  const result = await strapi.db.connection.raw(tokenVersionBumpSql(target), [userId]);
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
    isRecord(db.metadata) &&
    typeof db.metadata.get === "function" &&
    typeof strapi.plugin === "function";
  if (!ok) {
    throw new Error(
      "[users-permissions-extension] a factory did not receive { strapi } with config, plugin and a db " +
        "with query/connection/dialect/getSchemaName/metadata (FX40 tripwire).",
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
    const pending = (async () => {
      const version =
        userId === null
          ? null
          : snapshot?.userId === userId
            ? snapshot.version
            : await currentTokenVersion(strapi, userId);
      const stamped =
        version === null || !isRecord(plain) ? plain : { ...plain, [TOKEN_VERSION_CLAIM]: version };
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

  return service;
}

/** An edit() that writes a password (any value but undefined: clearing one counts too). */
function setsPassword(params: unknown): boolean {
  return isRecord(params) && params.password !== undefined;
}

/**
 * Patches a user service instance: an edit() that writes a password first
 * raises the user's version (bumpTokenVersion) and only then lets the
 * plugin save it. A failed bump throws before anything is saved; a failed
 * save after the bump leaves the old password with every older JWT
 * revoked. In a password action the committed version goes to the
 * action's issue() (passwordChange).
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
    const committed: VersionSnapshot = { userId: id, version: await bumpTokenVersion(strapi, id) };
    const change = passwordChange.getStore();
    if (change) change.committed = committed;
    let result: unknown;
    try {
      result = await originalEdit.call(this, userId, params, ...rest);
    } catch (error) {
      strapi.log?.warn?.(
        `[auth] password not changed: user=${id} tokenVersion=${committed.version} ` +
          "(saving it failed after the version was raised: the password is unchanged, the user's sessions are signed out)",
      );
      throw error;
    }
    strapi.log?.info?.(`[auth] password changed: user=${id} tokenVersion=${committed.version}`);
    return result;
  };

  return service;
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
 * their answer carries the version their edit() committed before saving.
 */
export function patchAuthController(
  controller: Record<string, unknown>,
  strapi: TokenVersionStrapi,
): Record<string, unknown> {
  const jwtService = () => strapi.plugin("users-permissions").service("jwt") as JwtService;

  /**
   * Runs a password action in a passwordChange context. Its edit() bumped
   * before saving, and the JWT of its answer carries that version. A
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
      const result = await passwordChange.run(change, () => original.call(this, ctx, ...rest));
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
      body.jwt = await knownVersion.run(committed, () => jwtService().issue({ id: userId }));
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
  controller[SIGN_IN_ACTION] = async function (
    this: unknown,
    ctx: AuthContext,
    ...rest: unknown[]
  ) {
    const snapshot = refreshMode(strapi) ? null : await signInTokenVersion(strapi, ctx);
    if (!snapshot) return signIn.call(this, ctx, ...rest);
    return knownVersion.run(snapshot, () => signIn.call(this, ctx, ...rest));
  };

  passwordAction("changePassword", (ctx) => userIdOf(ctx.state?.user?.id));
  passwordAction("resetPassword", (ctx) => {
    const body = ctx.body;
    return userIdOf(isRecord(body) && isRecord(body.user) ? body.user.id : undefined);
  });

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
    return plugin;
  };
}

export default createUsersPermissionsExtension();
