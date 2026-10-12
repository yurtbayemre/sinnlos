/**
 * A password change revokes the user's older JWTs (FX40, owner default:
 * a token version on the legacy JWTs).
 *
 * users-permissions runs in `jwtManagement: 'legacy-support'` (the default;
 * config/plugins.ts sets no mode): its JWTs are plain signed tokens,
 * valid until `exp`, and nothing on the server could end one earlier. Now:
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
 *  - POST /api/auth/change-password (and /api/auth/reset-password, which
 *    the permission bootstrap revokes for `public`, should an operator
 *    grant it again) bumps the version after the password was saved and
 *    answers with a JWT of the new version. The web stores that JWT in the
 *    session of the tab that changed the password
 *    (apps/web/src/lib/profile-actions.ts); every other session of the user
 *    gets 401 on its next request and lands on /sign-in?expired=1.
 *
 * A sign-in stamps the version the user had BEFORE the plugin checked the
 * password: the wrapped `callback` (local provider) reads it first, with
 * the plugin's own identifier lookup, and issue() takes it for that user
 * (signInVersion, an AsyncLocalStorage). The plugin reads the hash, runs
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
 * `jwt` service and the `auth` controller are factories, so their
 * factories are WRAPPED and the instances they return are patched; nothing
 * is assigned onto a factory (that would be inert, roadmap FX16).
 *  - The service's `issue` becomes asynchronous in legacy mode (it must read
 *    the version first). The plugin's own controllers put its result into
 *    `ctx.body.jwt` without awaiting it, so every action of the wrapped
 *    auth controller settles a pending `jwt` before it returns. The Entra
 *    exchange already awaits it (refresh mode returns a promise too).
 *  - `verify` runs the plugin's own check first (signature, expiry), then
 *    the version check; getToken() calls it through `this`, so the patched
 *    instance method is the one the users-permissions strategy uses.
 *
 * With `jwtManagement: 'refresh'` the plugin revokes sessions itself (its
 * session manager; a password change invalidates the refresh tokens), and
 * every wrapper here passes through untouched. Switching to it is a
 * separate decision (D-SESSION-01 and D-ENTRA-01 lifetimes).
 *
 * Upgrade tripwire: the factories, the service methods, the sign-in action
 * and the two password actions are asserted at plugin load and at
 * instantiation (still during boot); a Strapi upgrade that changes them
 * fails the boot instead of silently dropping the revocation.
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
      update(args: Record<string, unknown>): Promise<unknown>;
    };
  };
  plugin(name: string): { service(name: string): unknown };
  log?: { info?(message: string): void; warn?(message: string): void };
}

type Factory = (deps: { strapi: TokenVersionStrapi }) => unknown;

type JwtIssue = (this: unknown, payload: unknown, options?: unknown) => unknown;
type JwtVerify = (this: unknown, token: string) => Promise<unknown>;

export interface JwtService extends Record<string, unknown> {
  issue: JwtIssue;
  verify: JwtVerify;
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

/** The version a sign-in read before its password check (patchAuthController). */
const signInVersion = new AsyncLocalStorage<VersionSnapshot>();

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

/**
 * Counts the user's version up by one (read, then write: two changes of
 * one user in the same instant both end at +1, and both revoke every older
 * JWT, which is all that matters).
 */
export async function bumpTokenVersion(
  strapi: TokenVersionStrapi,
  userId: number,
): Promise<number> {
  const current = (await currentTokenVersion(strapi, userId)) ?? 0;
  const next = current + 1;
  await strapi.db.query(USER_UID).update({ where: { id: userId }, data: { tokenVersion: next } });
  return next;
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
  const ok =
    isRecord(strapi) &&
    isRecord(strapi.config) &&
    typeof strapi.config.get === "function" &&
    isRecord(strapi.db) &&
    typeof strapi.db.query === "function" &&
    typeof strapi.plugin === "function";
  if (!ok) {
    throw new Error(
      "[users-permissions-extension] a factory did not receive { strapi } with config/db/plugin (FX40 tripwire).",
    );
  }
}

/**
 * Patches a jwt service instance: issue() stamps the version (a sign-in's
 * snapshot for its own user, else the current one), verify() checks it.
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
    // Read now, in the caller's context: the sign-in's snapshot.
    const snapshot = signInVersion.getStore();
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

/** Replaces a pending `ctx.body.jwt` (issue() in legacy mode) by the JWT it resolves to. */
export async function settleIssuedJwt(ctx: AuthContext): Promise<void> {
  const body = ctx.body;
  if (isRecord(body) && isThenable(body.jwt)) body.jwt = await body.jwt;
}

/**
 * Patches an auth controller instance: every action settles the JWT it
 * answers with; a local sign-in reads the version before its password
 * check; the password actions then revoke the older JWTs and answer with
 * one of the new version.
 */
export function patchAuthController(
  controller: Record<string, unknown>,
  strapi: TokenVersionStrapi,
): Record<string, unknown> {
  const jwtService = () => strapi.plugin("users-permissions").service("jwt") as JwtService;

  /** After a successful password action: bump, then a JWT of the new version. */
  const revokeOlderTokens = async (ctx: AuthContext, userId: number | null) => {
    if (refreshMode(strapi) || userId === null) return;
    const body = ctx.body;
    // A refused change threw before; no JWT in the answer means no success.
    if (!isRecord(body) || typeof body.jwt !== "string") return;
    const version = await bumpTokenVersion(strapi, userId);
    body.jwt = await jwtService().issue({ id: userId });
    strapi.log?.info?.(`[auth] password changed: user=${userId} tokenVersion=${version}`);
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
    return signInVersion.run(snapshot, () => signIn.call(this, ctx, ...rest));
  };

  const changePassword = controller.changePassword as Action;
  controller.changePassword = async function (this: unknown, ctx: AuthContext, ...rest: unknown[]) {
    const result = await changePassword.call(this, ctx, ...rest);
    await revokeOlderTokens(ctx, userIdOf(ctx.state?.user?.id));
    return result;
  };

  const resetPassword = controller.resetPassword as Action;
  controller.resetPassword = async function (this: unknown, ctx: AuthContext, ...rest: unknown[]) {
    const result = await resetPassword.call(this, ctx, ...rest);
    const body = ctx.body;
    const user = isRecord(body) && isRecord(body.user) ? body.user : null;
    await revokeOlderTokens(ctx, userIdOf(user?.id));
    return result;
  };

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
