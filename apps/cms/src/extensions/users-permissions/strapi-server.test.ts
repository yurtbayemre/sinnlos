/**
 * The token-version wrapper of users-permissions (FX40) on the plugin's
 * REAL `jwt` service factory (@strapi/plugin-users-permissions 5.55.1,
 * jsonwebtoken signing and verifying with a test secret) and a fake `auth`
 * controller factory that behaves like the plugin's legacy code for what the
 * wrapper relies on: it puts issue()'s result into ctx.body.jwt without
 * awaiting it, and a refused password change throws. The sign-in race
 * (a password change between the hash read and issue()) runs through the
 * plugin's REAL `callback` with a stubbed store, user service and
 * sanitizer, and so do the plugin's REAL `changePassword` and
 * `resetPassword` (the version is raised before they save the password).
 * Overlapping password changes of one user run on a real SQLite database
 * (@strapi/database 5.55.1), paused (or failed) at chosen points of one
 * change while the others go through. The end-to-end run (the real
 * controller over HTTP, SQLite and Postgres) is
 * token-version.integration.test.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cmsPackageDir,
  openSqliteEngine,
  requirePackageFile,
  type SqliteEngine,
} from "../../test/sqlite-engine.test.helper";
import {
  TOKEN_VERSION_CLAIM,
  USER_UID,
  bumpTokenVersion,
  createUserWriteGuard,
  createUsersPermissionsExtension,
  patchUserService,
  registerUserWriteGuard,
  tokenVersionBumpSql,
  type AuthContext,
  type JwtService,
  type RawRunner,
  type TokenVersionStrapi,
  type UsersPermissionsPlugin,
} from "./strapi-server";

type Factory = (deps: { strapi: unknown }) => unknown;

/** The bump statement on the user table as Strapi's metadata names it. */
const BUMP_SQL =
  'UPDATE "up_users" SET "token_version" = COALESCE("token_version", 0) + 1 WHERE "id" = ? RETURNING "token_version"';

/** Strapi's metadata of the user table: what the bump reads. */
const userMetadata = {
  get: (uid: string) => {
    expect(uid).toBe(USER_UID);
    return {
      tableName: "up_users",
      attributes: { id: { columnName: "id" }, tokenVersion: { columnName: "token_version" } },
    };
  },
};

/**
 * The db slice of a fake Strapi beyond query(): knex's raw() for the one
 * statement the extension sends (the bump, applied to `rows` like SQLite
 * would), SQLite as the dialect.
 */
function fakeBumpDb<T extends { tokenVersion?: number | null }>(
  rows: Map<number, T>,
  queries?: string[],
) {
  // Strapi's transaction context, faked: nested calls join, the outermost
  // restores the rows when its callback throws.
  const inside = new AsyncLocalStorage<boolean>();
  return {
    inTransaction: () => inside.getStore() === true,
    async transaction<R>(
      this: { connection: { raw(sql: string, bindings: readonly unknown[]): Promise<unknown> } },
      callback: (scope: {
        trx: { raw(sql: string, bindings: readonly unknown[]): Promise<unknown> };
      }) => Promise<R>,
    ): Promise<R> {
      const trx = {
        raw: (sql: string, bindings: readonly unknown[]) => this.connection.raw(sql, bindings),
      };
      if (inside.getStore()) return callback({ trx });
      const snapshot = new Map([...rows].map(([id, row]) => [id, { ...row }]));
      queries?.push("begin");
      try {
        const result = await inside.run(true, () => callback({ trx }));
        queries?.push("commit");
        return result;
      } catch (error) {
        rows.clear();
        for (const [id, row] of snapshot) rows.set(id, row);
        queries?.push("rollback");
        throw error;
      }
    },
    connection: {
      async raw(sql: string, bindings: readonly unknown[]) {
        expect(sql).toBe(BUMP_SQL);
        const id = bindings[0] as number;
        queries?.push(`bump ${id}`);
        const row = rows.get(id);
        if (!row) return [];
        const next = (row.tokenVersion ?? 0) + 1;
        rows.set(id, { ...row, tokenVersion: next });
        return [{ token_version: next }];
      },
    },
    dialect: { client: "sqlite" },
    getSchemaName: () => undefined,
    metadata: userMetadata,
  };
}

/** The plugin's own jwt service factory, as its server index registers it. */
const realJwtFactory = requirePackageFile<{ __require(): Factory }>(
  cmsPackageDir("@strapi/plugin-users-permissions"),
  "dist/server/services/jwt.js",
).__require();

/** The plugin's own auth controller factory (controllers/auth.js). */
const realAuthFactory = requirePackageFile<{ __require(): Factory }>(
  cmsPackageDir("@strapi/plugin-users-permissions"),
  "dist/server/controllers/auth.js",
).__require();

/** The payload of a JWT, unverified. */
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

interface Harness {
  strapi: TokenVersionStrapi;
  users: Map<
    number,
    { id: number; tokenVersion?: number | null; password?: string; documentId?: string }
  >;
  jwt: JwtService;
  auth: Record<string, (ctx: AuthContext, ...rest: unknown[]) => Promise<unknown>>;
  /** The (wrapped) users-permissions user service. */
  userService: { edit(id: number, params: Record<string, unknown>): Promise<unknown> };
  queries: string[];
  logs: string[];
  /** The legacy-support issue() of the plugin itself, unwrapped. */
  rawIssue(payload: object): string;
}

/**
 * A fake users-permissions `user` service factory: edit() writes the given
 * fields through the query engine (the plugin's goes through the Document
 * Service, which hashes the password).
 */
function fakeUserFactory(): Factory {
  type Writable = { query(uid: string): { update(args: object): Promise<unknown> } };
  return ({ strapi }) => ({
    async edit(userId: number, params: Record<string, unknown>) {
      const db = (strapi as { db: Writable }).db;
      return db.query(USER_UID).update({ where: { id: userId }, data: params });
    },
  });
}

type PasswordBody = { currentPassword?: string; password?: string };

/**
 * A fake auth controller factory with the plugin's legacy behaviour: the
 * password actions persist the new password through the user service's
 * edit(), then answer with issue()'s result, unawaited.
 */
function fakeAuthFactory(): Factory {
  return ({ strapi }) => {
    const service = (name: string) =>
      (strapi as TokenVersionStrapi).plugin("users-permissions").service(name);
    const jwt = () => service("jwt") as JwtService;
    const users = () =>
      service("user") as { edit(id: number, params: Record<string, unknown>): Promise<unknown> };
    const answer = (ctx: AuthContext, id: number) => {
      // The plugin: ctx.send({ jwt: getService('jwt').issue({ id }), user })
      ctx.body = { jwt: jwt().issue({ id: id }), user: { id, username: `u${id}` } };
    };
    return {
      async callback(
        ctx: AuthContext & {
          request: { body: { id?: number; identifier?: string; password?: string } };
        },
      ) {
        const body = ctx.request.body;
        if (body.identifier === undefined) return answer(ctx, body.id as number);
        // The plugin's local sign-in: the user, then its password.
        const row = (await (strapi as TokenVersionStrapi).db.query(USER_UID).findOne({
          where: {
            provider: "local",
            $or: [{ email: body.identifier.toLowerCase() }, { username: body.identifier }],
          },
        })) as { id: number; password?: string } | null;
        if (!row || row.password !== body.password) {
          throw new Error("Invalid identifier or password");
        }
        answer(ctx, row.id);
      },
      async changePassword(ctx: AuthContext & { request: { body: PasswordBody } }) {
        if (ctx.request.body.currentPassword !== "right") {
          throw new Error("The provided current password is invalid");
        }
        const id = ctx.state?.user?.id as number;
        await users().edit(id, { password: ctx.request.body.password ?? "new-password" });
        answer(ctx, id);
      },
      async resetPassword(ctx: AuthContext & { request: { body: { id: number } & PasswordBody } }) {
        const id = ctx.request.body.id;
        await users().edit(id, {
          resetPasswordToken: null,
          password: ctx.request.body.password ?? "new-password",
        });
        answer(ctx, id);
      },
      async logout(ctx: AuthContext) {
        ctx.body = { ok: true };
      },
    };
  };
}

function harness(
  mode: "legacy-support" | "refresh" = "legacy-support",
  authFactory: Factory = fakeAuthFactory(),
): Harness {
  const users: Harness["users"] = new Map([
    [1, { id: 1, tokenVersion: 0 }],
    [2, { id: 2, tokenVersion: 3 }],
    [3, { id: 3, tokenVersion: null }],
  ]);
  const queries: string[] = [];
  const logs: string[] = [];
  const config: Record<string, unknown> = {
    "plugin::users-permissions.jwtSecret": "unit-test-secret",
    "plugin::users-permissions.jwt": { expiresIn: "7d" },
    "plugin::users-permissions.jwtManagement": mode,
  };
  const services: Record<string, unknown> = {};
  const strapi: TokenVersionStrapi = {
    config: { get: (path, fallback) => (path in config ? config[path] : fallback) },
    db: {
      query(uid) {
        expect(uid).toBe(USER_UID);
        return {
          async findOne(args) {
            queries.push(`findOne ${JSON.stringify(args)}`);
            const where = args.where as { id?: number; documentId?: string };
            const row =
              where.documentId !== undefined
                ? [...users.values()].find((user) => user.documentId === where.documentId)
                : users.get(where.id as number);
            return row ? { ...row } : null;
          },
          async update(args) {
            queries.push(`update ${JSON.stringify(args)}`);
            const id = (args.where as { id: number }).id;
            const row = { ...users.get(id)!, ...(args.data as object) };
            users.set(id, row);
            return row;
          },
        };
      },
      ...fakeBumpDb(users, queries),
    },
    plugin: () => ({ service: (name: string) => services[name] }),
    log: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
    },
  };
  const plugin: UsersPermissionsPlugin = {
    services: { jwt: realJwtFactory, user: fakeUserFactory() },
    controllers: { auth: authFactory },
  };
  createUsersPermissionsExtension()(plugin);
  services.jwt = (plugin.services.jwt as Factory)({ strapi });
  services.user = (plugin.services.user as Factory)({ strapi });
  const auth = (plugin.controllers.auth as Factory)({ strapi }) as Harness["auth"];
  const raw = realJwtFactory({ strapi }) as JwtService;
  return {
    strapi,
    users,
    jwt: services.jwt as JwtService,
    auth,
    userService: services.user as Harness["userService"],
    queries,
    logs,
    rawIssue: (payload) => raw.issue(payload) as string,
  };
}

/** The context of POST /api/auth/change-password by `userId`. */
const passwordCtx = (userId: number, currentPassword = "right") =>
  ({ state: { user: { id: userId } }, request: { body: { currentPassword } } }) as AuthContext & {
    body?: { jwt?: unknown; user?: unknown };
  };

describe("jwt service: issue()", () => {
  it("stamps the user's current version into the claim tv (async in legacy mode)", async () => {
    const h = harness();
    const pending = h.jwt.issue({ id: 2 });
    expect(pending).toBeInstanceOf(Promise);
    const jwt = await pending;
    expect(typeof jwt).toBe("string");
    expect(claims(jwt as string)).toMatchObject({ id: 2, [TOKEN_VERSION_CLAIM]: 3 });
    // The plugin's defaults still apply (7 days).
    const { iat, exp } = claims(jwt as string) as { iat: number; exp: number };
    expect(exp - iat).toBe(7 * 24 * 60 * 60);
  });

  it("stamps 0 for a user without a stored version, and keeps given options", async () => {
    const h = harness();
    const jwt = (await h.jwt.issue({ id: 3 }, { expiresIn: "12h" })) as string;
    const payload = claims(jwt) as { tv: number; iat: number; exp: number };
    expect(payload.tv).toBe(0);
    expect(payload.exp - payload.iat).toBe(12 * 60 * 60);
  });

  it("stamps nothing without a known user id", async () => {
    const h = harness();
    expect(claims((await h.jwt.issue({ id: 99 })) as string)).not.toHaveProperty("tv");
    expect(claims((await h.jwt.issue({ purpose: "x" })) as string)).not.toHaveProperty("tv");
  });

  it("takes a model instance's toJSON(), like the plugin", async () => {
    const h = harness();
    const jwt = (await h.jwt.issue({ toJSON: () => ({ id: 2 }) })) as string;
    expect(claims(jwt)).toMatchObject({ id: 2, tv: 3 });
  });
});

describe("jwt service: verify()", () => {
  it("accepts a JWT of the user's current version", async () => {
    const h = harness();
    const jwt = (await h.jwt.issue({ id: 2 })) as string;
    await expect(h.jwt.verify(jwt)).resolves.toMatchObject({ id: 2, tv: 3 });
  });

  it("counts a JWT without the claim as version 0: nobody is signed out by the deploy", async () => {
    const h = harness();
    const legacy = h.rawIssue({ id: 1 });
    expect(claims(legacy)).not.toHaveProperty("tv");
    await expect(h.jwt.verify(legacy)).resolves.toMatchObject({ id: 1 });
    // A stored NULL (a column added without the default) is 0 as well.
    await expect(h.jwt.verify(h.rawIssue({ id: 3 }))).resolves.toMatchObject({ id: 3 });
  });

  it("refuses a JWT of an older (or any other) version", async () => {
    const h = harness();
    await expect(h.jwt.verify(h.rawIssue({ id: 2 }))).rejects.toThrow("Invalid token.");
    await expect(h.jwt.verify(h.rawIssue({ id: 2, tv: 2 }))).rejects.toThrow("Invalid token.");
    await expect(h.jwt.verify(h.rawIssue({ id: 1, tv: 1 }))).rejects.toThrow("Invalid token.");
  });

  it("leaves the plugin's own refusals and an unknown user to the plugin", async () => {
    const h = harness();
    await expect(h.jwt.verify("not.a.jwt")).rejects.toThrow("Invalid token.");
    // No such user: the strategy answers "Invalid credentials" itself.
    await expect(h.jwt.verify(h.rawIssue({ id: 99, tv: 5 }))).resolves.toMatchObject({ id: 99 });
  });

  it("reads a numeric string id like the plugin's lookup would", async () => {
    const h = harness();
    await expect(h.jwt.verify(h.rawIssue({ id: "2" }))).rejects.toThrow("Invalid token.");
  });

  it("is what getToken() (the users-permissions strategy) uses", async () => {
    const h = harness();
    const getToken = h.jwt.getToken as (ctx: unknown) => Promise<unknown>;
    const ctx = (jwt: string) => ({ request: { header: { authorization: `Bearer ${jwt}` } } });
    await expect(getToken.call(h.jwt, ctx(h.rawIssue({ id: 2 })))).rejects.toThrow(
      "Invalid token.",
    );
    const current = (await h.jwt.issue({ id: 2 })) as string;
    await expect(getToken.call(h.jwt, ctx(current))).resolves.toMatchObject({ id: 2 });
  });
});

describe("auth controller", () => {
  it("every action answers with the JWT itself, not a pending one (sign-in)", async () => {
    const h = harness();
    const ctx = { request: { body: { id: 2 } } } as AuthContext & { body?: { jwt?: unknown } };
    await h.auth.callback(ctx);
    expect(typeof ctx.body?.jwt).toBe("string");
    expect(claims(ctx.body?.jwt as string)).toMatchObject({ id: 2, tv: 3 });
  });

  it("a password change bumps the version, revokes the older JWTs and answers with a current one", async () => {
    const h = harness();
    const before = (await h.jwt.issue({ id: 2 })) as string;
    const ctx = passwordCtx(2);
    await h.auth.changePassword(ctx);
    expect(h.users.get(2)?.tokenVersion).toBe(4);
    const fresh = ctx.body?.jwt as string;
    expect(claims(fresh)).toMatchObject({ id: 2, tv: 4 });
    await expect(h.jwt.verify(fresh)).resolves.toMatchObject({ id: 2 });
    await expect(h.jwt.verify(before)).rejects.toThrow("Invalid token.");
    expect(h.logs).toContain("[auth] password changed: user=2 tokenVersion=4");
  });

  it("a legacy JWT (no claim) is revoked by the first password change", async () => {
    const h = harness();
    const legacy = h.rawIssue({ id: 1 });
    await h.auth.changePassword(passwordCtx(1));
    await expect(h.jwt.verify(legacy)).rejects.toThrow("Invalid token.");
  });

  it("a refused password change changes nothing", async () => {
    const h = harness();
    await expect(h.auth.changePassword(passwordCtx(2, "wrong"))).rejects.toThrow(
      "current password is invalid",
    );
    expect(h.users.get(2)?.tokenVersion).toBe(3);
    expect(h.queries.filter((q) => q.startsWith("update"))).toEqual([]);
  });

  it("a password reset revokes the older JWTs of the user it names", async () => {
    const h = harness();
    const ctx = { request: { body: { id: 1 } } } as AuthContext & { body?: { jwt?: unknown } };
    await h.auth.resetPassword(ctx);
    expect(h.users.get(1)?.tokenVersion).toBe(1);
    expect(claims(ctx.body?.jwt as string)).toMatchObject({ id: 1, tv: 1 });
  });

  it("leaves actions without a JWT alone", async () => {
    const h = harness();
    const ctx = {} as AuthContext;
    await h.auth.logout(ctx);
    expect(ctx.body).toEqual({ ok: true });
  });

  it("raises the version before the plugin saves the password", async () => {
    const h = harness();
    await h.auth.changePassword(passwordCtx(2));
    // In one transaction: the version and the password commit together.
    expect(h.queries.filter((q) => !q.startsWith("findOne"))).toEqual([
      "begin",
      "bump 2",
      `update ${JSON.stringify({ where: { id: 2 }, data: { password: "new-password" } })}`,
      "commit",
    ]);
  });
});

describe("user service: every password it saves revokes the older JWTs", () => {
  it("bumps before an edit() with a password outside the password actions (PUT /api/users/:id)", async () => {
    const h = harness();
    const legacy = h.rawIssue({ id: 1 });
    await h.userService.edit(1, { password: "set-elsewhere" });
    expect(h.queries.filter((q) => !q.startsWith("findOne"))).toEqual([
      "begin",
      "bump 1",
      `update ${JSON.stringify({ where: { id: 1 }, data: { password: "set-elsewhere" } })}`,
      "commit",
    ]);
    await expect(h.jwt.verify(legacy)).rejects.toThrow("Invalid token.");
    expect(h.logs).toEqual(["[auth] password changed: user=1 tokenVersion=1"]);
  });

  it("leaves an edit() without a password alone", async () => {
    const h = harness();
    await h.userService.edit(1, { confirmationToken: "abc" });
    expect(h.queries).toEqual([
      `update ${JSON.stringify({ where: { id: 1 }, data: { confirmationToken: "abc" } })}`,
    ]);
    expect(h.users.get(1)?.tokenVersion).toBe(0);
  });

  it("refuses a password for a user id it cannot revoke, before saving anything", async () => {
    const h = harness();
    await expect(h.userService.edit("x" as unknown as number, { password: "p" })).rejects.toThrow(
      "without a numeric id is refused",
    );
    expect(h.queries).toEqual([]);
  });

  it("an upgraded action that saves the password some other way is revoked afterwards (tripwire)", async () => {
    // A plugin version whose changePassword no longer saves through edit().
    const bypass: Factory = ({ strapi }) => {
      const fake = fakeAuthFactory()({ strapi }) as Record<string, unknown>;
      return {
        ...fake,
        async changePassword(ctx: AuthContext) {
          const id = ctx.state?.user?.id as number;
          const db = (strapi as { db: { query(uid: string): { update(a: object): unknown } } }).db;
          await db.query(USER_UID).update({ where: { id }, data: { password: "direct" } });
          const jwt = (strapi as TokenVersionStrapi).plugin("x").service("jwt") as JwtService;
          ctx.body = { jwt: jwt.issue({ id }), user: { id } };
        },
      };
    };
    const h = harness("legacy-support", bypass);
    const before = (await h.jwt.issue({ id: 2 })) as string;
    const ctx = passwordCtx(2);
    await h.auth.changePassword(ctx);
    expect(claims(ctx.body?.jwt as string)).toMatchObject({ id: 2, tv: 4 });
    await expect(h.jwt.verify(before)).rejects.toThrow("Invalid token.");
    expect(h.logs[0]).toMatch(/^error .*changePassword answered without saving the password/);
    expect(h.logs[1]).toBe("[auth] password changed: user=2 tokenVersion=4");
  });
});

describe("the plugin's real auth controller: sign-in reads the version before the password check, password actions bump before saving", () => {
  interface Row {
    id: number;
    username: string;
    email: string;
    provider: string;
    password: string;
    confirmed: boolean;
    blocked: boolean;
    tokenVersion: number;
    resetPasswordToken: string | null;
  }
  type SignInCtx = AuthContext & { send(body: unknown): void; body?: { jwt?: unknown } };

  /**
   * The plugin's auth controller on a stubbed Strapi: `duringPasswordCheck`
   * runs inside validatePassword, i.e. between the plugin's hash read and
   * its issue(). The user service is a factory the extension wraps; its
   * edit() records the stored version at the moment the plugin saves.
   * `faults` makes the bump or the save fail. getService() and
   * sanitizeUser() read the global `strapi`.
   */
  function signInHarness(
    duringPasswordCheck: (strapi: TokenVersionStrapi) => Promise<void> = async () => undefined,
  ) {
    const users = new Map<number, Row>([
      [
        5,
        {
          id: 5,
          username: "casey",
          email: "casey@example.test",
          provider: "local",
          password: "hash-of-old-password",
          confirmed: true,
          blocked: false,
          tokenVersion: 2,
          resetPasswordToken: "reset-code",
        },
      ],
    ]);
    const lookups: unknown[] = [];
    const faults = { bump: false, save: false };
    const saves: { id: number; params: Record<string, unknown>; versionAtSave: number }[] = [];
    const logs: string[] = [];
    const userFactory: Factory = () => ({
      async validatePassword(given: string, hash: string) {
        await duringPasswordCheck(strapi as unknown as TokenVersionStrapi);
        return given === "old-password" && hash === "hash-of-old-password";
      },
      async edit(id: number, params: Record<string, unknown>) {
        saves.push({ id, params, versionAtSave: users.get(id)!.tokenVersion });
        if (faults.save) throw new Error("the Document Service failed");
        const row = { ...users.get(id)!, ...(params as Partial<Row>) };
        users.set(id, row);
        return row;
      },
    });
    const services: Record<string, unknown> = {};
    const bumpDb = fakeBumpDb(users);
    const config: Record<string, unknown> = {
      "plugin::users-permissions.jwtSecret": "unit-test-secret",
      "plugin::users-permissions.jwt": { expiresIn: "7d" },
      "plugin::users-permissions.jwtManagement": "legacy-support",
    };
    const strapi = {
      config: {
        get: (path: string, fallback?: unknown) => (path in config ? config[path] : fallback),
      },
      db: {
        query(uid: string) {
          expect(uid).toBe(USER_UID);
          return {
            async findOne(args: Record<string, unknown>) {
              const where = args.where as {
                id?: number;
                provider?: string;
                $or?: [{ email: string }, { username: string }];
              };
              if (where.id !== undefined) {
                const row = users.get(where.id);
                return row ? { ...row } : null;
              }
              const code = (args.where as { resetPasswordToken?: string }).resetPasswordToken;
              if (code !== undefined) {
                const row = [...users.values()].find((user) => user.resetPasswordToken === code);
                return row ? { ...row } : null;
              }
              lookups.push(args);
              const [byEmail, byName] = where.$or ?? [];
              const row = [...users.values()].find(
                (user) =>
                  user.provider === where.provider &&
                  (user.email === byEmail?.email || user.username === byName?.username),
              );
              return row ? { ...row } : null;
            },
            async update(args: Record<string, unknown>) {
              const id = (args.where as { id: number }).id;
              const row = { ...users.get(id)!, ...(args.data as Partial<Row>) };
              users.set(id, row);
              return row;
            },
          };
        },
        ...bumpDb,
        connection: {
          async raw(sql: string, bindings: readonly unknown[]) {
            if (faults.bump) throw new Error("connection lost");
            return bumpDb.connection.raw(sql, bindings);
          },
        },
      },
      plugin: () => ({ service: (name: string) => services[name] }),
      store: () => ({
        get: async ({ key }: { key: string }) =>
          key === "grant" ? { email: { enabled: true } } : { email_confirmation: false },
      }),
      getModel: () => ({ uid: USER_UID, attributes: {} }),
      contentAPI: {
        sanitize: { output: async (user: Row) => ({ id: user.id, username: user.username }) },
      },
      log: {
        info: (message: string) => logs.push(message),
        warn: (message: string) => logs.push(`warn ${message}`),
      },
    };
    const plugin: UsersPermissionsPlugin = {
      services: { jwt: realJwtFactory, user: userFactory },
      controllers: { auth: realAuthFactory },
    };
    createUsersPermissionsExtension()(plugin);
    services.jwt = (plugin.services.jwt as Factory)({ strapi });
    services.user = (plugin.services.user as Factory)({ strapi });
    const auth = (plugin.controllers.auth as Factory)({ strapi }) as Record<
      string,
      (ctx: SignInCtx) => Promise<unknown>
    >;
    /** Runs an action of the plugin with `ctx`, the global `strapi` stubbed. */
    const run = async (action: string, ctx: SignInCtx) => {
      vi.stubGlobal("strapi", strapi);
      try {
        await auth[action]!(ctx);
      } finally {
        vi.unstubAllGlobals();
      }
      return ctx.body?.jwt as string;
    };
    const actionCtx = (body: Record<string, unknown>, userId?: number): SignInCtx => {
      const ctx: SignInCtx = {
        params: {},
        request: { body },
        state: userId === undefined ? {} : { user: { id: userId } },
        send(answer) {
          ctx.body = answer as SignInCtx["body"];
        },
      };
      return ctx;
    };
    const signIn = async (identifier: string, password = "old-password") => {
      const ctx: SignInCtx = {
        params: {},
        request: { body: { identifier, password } },
        state: {},
        send(body) {
          ctx.body = body as SignInCtx["body"];
        },
      };
      vi.stubGlobal("strapi", strapi);
      try {
        await auth.callback(ctx);
      } finally {
        vi.unstubAllGlobals();
      }
      return ctx.body?.jwt;
    };
    const changePassword = (password: string) =>
      run(
        "changePassword",
        actionCtx({ currentPassword: "old-password", password, passwordConfirmation: password }, 5),
      );
    const resetPassword = (password: string) =>
      run(
        "resetPassword",
        actionCtx({ code: "reset-code", password, passwordConfirmation: password }),
      );
    return {
      strapi: strapi as unknown as TokenVersionStrapi,
      users,
      lookups,
      faults,
      saves,
      logs,
      jwt: services.jwt as JwtService,
      signIn,
      changePassword,
      resetPassword,
    };
  }

  it("an undisturbed sign-in answers a JWT of the user's current version", async () => {
    const h = signInHarness();
    const jwt = await h.signIn("casey@example.test");
    expect(typeof jwt).toBe("string");
    expect(claims(jwt as string)).toMatchObject({ id: 5, tv: 2 });
    await expect(h.jwt.verify(jwt as string)).resolves.toMatchObject({ id: 5 });
  });

  it("a password change between the hash read and issue() revokes that sign-in's JWT too", async () => {
    // The concurrent change-password lands while bcrypt runs: its bump
    // comes after the plugin read the old hash, before the plugin's issue().
    const h = signInHarness(async (strapi) => {
      await bumpTokenVersion(strapi, 5);
    });
    const jwt = (await h.signIn("casey@example.test")) as string;
    expect(h.users.get(5)?.tokenVersion).toBe(3);
    // The version from before the password check, which the change revoked.
    expect(claims(jwt)).toMatchObject({ id: 5, tv: 2 });
    await expect(h.jwt.verify(jwt)).rejects.toThrow("Invalid token.");
  });

  it("looks the user up with the plugin's own where (provider local, lower-cased email or username)", async () => {
    const h = signInHarness();
    expect(claims((await h.signIn("Casey@Example.TEST")) as string)).toMatchObject({ tv: 2 });
    expect(claims((await h.signIn("casey")) as string)).toMatchObject({ tv: 2 });
    const byEmail = {
      provider: "local",
      $or: [{ email: "casey@example.test" }, { username: "Casey@Example.TEST" }],
    };
    const byName = { provider: "local", $or: [{ email: "casey" }, { username: "casey" }] };
    // Each sign-in: the version first, then the plugin's own lookup.
    expect(h.lookups).toEqual([
      { where: byEmail, select: ["id", "tokenVersion"] },
      { where: byEmail },
      { where: byName, select: ["id", "tokenVersion"] },
      { where: byName },
    ]);
  });

  it("a refused sign-in answers no JWT, as before", async () => {
    const h = signInHarness();
    await expect(h.signIn("casey@example.test", "wrong")).rejects.toThrow(
      "Invalid identifier or password",
    );
    await expect(h.signIn("nobody@example.test")).rejects.toThrow("Invalid identifier or password");
  });

  it("changePassword: the version is raised before the plugin saves, and the answer carries it", async () => {
    const h = signInHarness();
    const before = (await h.jwt.issue({ id: 5 })) as string;
    const jwt = await h.changePassword("new-password-1");
    expect(h.saves).toEqual([{ id: 5, params: { password: "new-password-1" }, versionAtSave: 3 }]);
    expect(h.users.get(5)).toMatchObject({ tokenVersion: 3, password: "new-password-1" });
    expect(claims(jwt)).toMatchObject({ id: 5, tv: 3 });
    await expect(h.jwt.verify(jwt)).resolves.toMatchObject({ id: 5 });
    await expect(h.jwt.verify(before)).rejects.toThrow("Invalid token.");
    expect(h.logs).toEqual(["[auth] password changed: user=5 tokenVersion=3"]);
  });

  it("changePassword: a failed bump fails the request before anything is saved", async () => {
    const h = signInHarness();
    const before = (await h.jwt.issue({ id: 5 })) as string;
    h.faults.bump = true;
    await expect(h.changePassword("new-password-1")).rejects.toThrow("connection lost");
    expect(h.saves).toEqual([]);
    expect(h.users.get(5)).toMatchObject({ tokenVersion: 2, password: "hash-of-old-password" });
    // Nothing changed: the old password and its sessions stay as they were.
    await expect(h.jwt.verify(before)).resolves.toMatchObject({ id: 5 });
    expect(h.logs).toEqual([
      "warn [auth] password not changed: user=5 (the change rolled back: the password and the user's sessions are as they were)",
    ]);
  });

  it("changePassword: a failed save rolls the bump back: old password, sessions as they were", async () => {
    const h = signInHarness();
    const before = (await h.jwt.issue({ id: 5 })) as string;
    h.faults.save = true;
    await expect(h.changePassword("new-password-1")).rejects.toThrow("the Document Service failed");
    expect(h.saves).toEqual([{ id: 5, params: { password: "new-password-1" }, versionAtSave: 3 }]);
    expect(h.users.get(5)).toMatchObject({ tokenVersion: 2, password: "hash-of-old-password" });
    await expect(h.jwt.verify(before)).resolves.toMatchObject({ id: 5 });
    expect(h.logs).toEqual([
      "warn [auth] password not changed: user=5 (the change rolled back: the password and the user's sessions are as they were)",
    ]);
  });

  it("resetPassword: the version is raised before the plugin saves, and the answer carries it", async () => {
    const h = signInHarness();
    const before = (await h.jwt.issue({ id: 5 })) as string;
    const jwt = await h.resetPassword("new-password-2");
    expect(h.saves).toEqual([
      {
        id: 5,
        params: { resetPasswordToken: null, password: "new-password-2" },
        versionAtSave: 3,
      },
    ]);
    expect(claims(jwt)).toMatchObject({ id: 5, tv: 3 });
    await expect(h.jwt.verify(before)).rejects.toThrow("Invalid token.");
  });

  it("resetPassword: a failed bump saves nothing, so the code still works for another try", async () => {
    const h = signInHarness();
    h.faults.bump = true;
    await expect(h.resetPassword("new-password-2")).rejects.toThrow("connection lost");
    expect(h.saves).toEqual([]);
    expect(h.users.get(5)).toMatchObject({
      tokenVersion: 2,
      password: "hash-of-old-password",
      resetPasswordToken: "reset-code",
    });
  });
});

describe("the bump statement", () => {
  const target = {
    schema: "public",
    table: "up_users",
    idColumn: "id",
    versionColumn: "token_version",
  };

  it("is one UPDATE … RETURNING on SQLite, a stored NULL counting as 0", () => {
    expect(tokenVersionBumpSql({ ...target, client: "sqlite" })).toBe(BUMP_SQL);
  });

  it("is schema-qualified on Postgres", () => {
    expect(tokenVersionBumpSql({ ...target, client: "postgres", schema: "tenant_a" })).toBe(
      'UPDATE "tenant_a"."up_users" SET "token_version" = COALESCE("token_version", 0) + 1 WHERE "id" = ? RETURNING "token_version"',
    );
  });

  it("refuses other databases", () => {
    expect(() => tokenVersionBumpSql({ ...target, client: "mysql" })).toThrow(/not supported/);
  });

  it("answers the version it committed, and throws for a user that does not exist", async () => {
    const h = harness();
    await expect(bumpTokenVersion(h.strapi, 3)).resolves.toBe(1);
    await expect(bumpTokenVersion(h.strapi, 2)).resolves.toBe(4);
    await expect(bumpTokenVersion(h.strapi, 99)).rejects.toThrow("was not raised (no such user)");
  });
});

/** Which password change a database call belongs to ("A", "B", "C"). */
const actor = new AsyncLocalStorage<string>();

/** Where the race harness can hold a change, or make it fail. */
type RacePoint = "before version write" | "after version write" | "before password write";

interface RaceHook {
  at(point: RacePoint): Promise<void>;
}

/**
 * Holds the change `who` the first time it reaches `point`, until
 * release(); `reached` resolves once it waits there. No timers: the test
 * awaits `reached`, runs the other changes to their end, then releases.
 */
function pauseAt(who: string, point: RacePoint) {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  return {
    reached,
    release,
    async at(current: RacePoint) {
      if (held || current !== point || actor.getStore() !== who) return;
      held = true;
      reach();
      await released;
    },
  };
}

/** Makes the change `who` fail at `point`, as a lost connection would. */
function failAt(who: string, point: RacePoint): RaceHook {
  return {
    async at(current) {
      if (current === point && actor.getStore() === who) {
        throw new Error(`connection lost at ${point}`);
      }
    },
  };
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The user table reduced to what a password change touches. */
function raceUserModel() {
  return {
    uid: USER_UID,
    singularName: "user",
    tableName: "up_users",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      username: { type: "string" },
      email: { type: "string" },
      provider: { type: "string" },
      password: { type: "string" },
      tokenVersion: { type: "integer" },
    },
  };
}

interface RaceHarness {
  userId: number;
  jwt: JwtService;
  logs: string[];
  /** The version the user's row held after each version write, in order. */
  history: number[];
  /** A JWT the user held before any change (version 0). */
  before: string;
  /** The change-password request of `who` (current password right); its answer's JWT. */
  change(who: string, password: string): Promise<string>;
  /** A local sign-in of the user with `password` (actor "S"); its JWT. */
  signIn(password: string): Promise<string>;
  stored(): Promise<{ version: number; password: string }>;
  /**
   * Resolves "done" once `work` has settled, or "waits" once a database
   * call waits for SQLite's only connection (held by a transaction): how
   * far another change or sign-in gets while one change is held.
   */
  doneOrWaiting(work: Promise<unknown>): Promise<"done" | "waits">;
}

/**
 * The extension around the real jwt service, the fake auth controller and
 * the fake user service, on a real SQLite database (@strapi/database
 * 5.55.1) holding one user. Every version write (through the query engine
 * or as raw SQL) and every password write passes the hooks, in the
 * context of the change that made it.
 */
async function raceHarness(engines: SqliteEngine[], hooks: RaceHook[]): Promise<RaceHarness> {
  const engine = await openSqliteEngine([raceUserModel()], { schema: "sync" });
  engines.push(engine);
  const db = engine.db;
  const created = await db.query(USER_UID).create({
    data: {
      username: "casey",
      email: "casey@example.test",
      provider: "local",
      password: "old-password",
      tokenVersion: 0,
    },
  });
  const userId = created.id as number;
  const at = async (point: RacePoint) => {
    for (const hook of hooks) await hook.at(point);
  };
  /** A raw runner whose version writes pass the hooks. */
  const gated = (runner: RawRunner): RawRunner => ({
    async raw(sql, bindings) {
      const writesVersion = /^UPDATE\b/.test(sql) && sql.includes('"token_version"');
      if (writesVersion) await at("before version write");
      const result = await runner.raw(sql, bindings);
      if (writesVersion) await afterVersionWrite();
      return result;
    },
  });
  const stored = async () => {
    const row = await db.query(USER_UID).findOne({ where: { id: userId } });
    return { version: Number(row?.tokenVersion ?? 0), password: String(row?.password) };
  };
  const history: number[] = [];
  const afterVersionWrite = async () => {
    history.push((await stored()).version);
    await at("after version write");
  };
  const logs: string[] = [];
  const services: Record<string, unknown> = {};
  const config: Record<string, unknown> = {
    "plugin::users-permissions.jwtSecret": "unit-test-secret",
    "plugin::users-permissions.jwt": { expiresIn: "7d" },
    "plugin::users-permissions.jwtManagement": "legacy-support",
  };
  const strapi: TokenVersionStrapi = {
    config: { get: (path, fallback) => (path in config ? config[path] : fallback) },
    db: {
      query(uid) {
        const repo = db.query(uid) as ReturnType<typeof db.query> & {
          update(args: Record<string, unknown>): Promise<unknown>;
        };
        return {
          findOne: (args) => repo.findOne(args),
          async update(args: Record<string, unknown>) {
            const data = isPlainRecord(args.data) ? args.data : {};
            const writesVersion = "tokenVersion" in data;
            if (writesVersion) await at("before version write");
            if ("password" in data) await at("before password write");
            const result = await repo.update(args);
            if (writesVersion) await afterVersionWrite();
            return result;
          },
        };
      },
      connection: gated(db.connection),
      inTransaction: () => (db as typeof db & { inTransaction(): boolean }).inTransaction(),
      // The engine's own transactions (Strapi's context: nested calls
      // join), with the version writes on the transaction gated as well.
      transaction: (callback) =>
        db.transaction((scope) => callback({ trx: gated(scope.trx as RawRunner) })),
      dialect: { client: "sqlite" },
      getSchemaName: () => undefined,
      metadata: db.metadata as unknown as TokenVersionStrapi["db"]["metadata"],
    },
    plugin: () => ({ service: (name: string) => services[name] }),
    log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  };
  const plugin: UsersPermissionsPlugin = {
    services: { jwt: realJwtFactory, user: fakeUserFactory() },
    controllers: { auth: fakeAuthFactory() },
  };
  createUsersPermissionsExtension()(plugin);
  services.jwt = (plugin.services.jwt as Factory)({ strapi });
  services.user = (plugin.services.user as Factory)({ strapi });
  const auth = (plugin.controllers.auth as Factory)({ strapi }) as Harness["auth"];
  const jwt = services.jwt as JwtService;
  const change = (who: string, password: string) =>
    actor.run(who, async () => {
      const ctx = {
        state: { user: { id: userId } },
        request: { body: { currentPassword: "right", password } },
      } as AuthContext & { body?: { jwt?: unknown } };
      await auth.changePassword(ctx);
      return ctx.body?.jwt as string;
    });
  const signIn = (password: string) =>
    actor.run("S", async () => {
      const ctx = {
        params: {},
        request: { body: { identifier: "casey", password } },
      } as AuthContext & { body?: { jwt?: unknown } };
      await auth.callback(ctx);
      return ctx.body?.jwt as string;
    });
  const pool = (db.connection as unknown as { client: { pool: { numPendingAcquires(): number } } })
    .client.pool;
  const doneOrWaiting = async (work: Promise<unknown>) => {
    let settled = false;
    work.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Condition-driven, no timers: each turn lets the work run on.
    for (let turn = 0; turn < 100_000; turn += 1) {
      if (settled) return "done" as const;
      if (pool.numPendingAcquires() > 0) return "waits" as const;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("the work neither finished nor waited for the connection");
  };
  return {
    userId,
    jwt,
    logs,
    history,
    before: (await jwt.issue({ id: userId })) as string,
    change,
    signIn,
    stored,
    doneOrWaiting,
  };
}

describe("overlapping password changes of one user (real SQLite)", () => {
  const engines: SqliteEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.close();
  });

  /**
   * Every change here runs as far as it can while change A is held: a
   * change or sign-in either finishes (no transaction holds anything, the
   * code before the one-transaction fix) or waits for SQLite's only
   * connection, which A's transaction holds (doneOrWaiting); then A goes
   * on. No timers.
   */

  it("the version never moves backwards: A held between reading and writing it while B and C change", async () => {
    const hold = pauseAt("A", "before version write");
    const h = await raceHarness(engines, [hold]);
    const a = h.change("A", "password-a");
    await hold.reached;
    const b = h.change("B", "password-b");
    await h.doneOrWaiting(b);
    const c = h.change("C", "password-c");
    await h.doneOrWaiting(c);
    hold.release();
    const [jwtA, jwtB, jwtC] = await Promise.all([a, b, c]);
    expect(h.history).toEqual([1, 2, 3]);
    expect(await h.stored()).toEqual({ version: 3, password: "password-c" });
    // Only the last change's JWT is current.
    for (const revoked of [h.before, jwtA, jwtB]) {
      await expect(h.jwt.verify(revoked)).rejects.toThrow("Invalid token.");
    }
    await expect(h.jwt.verify(jwtC)).resolves.toMatchObject({ id: h.userId, tv: 3 });
  }, 30_000);

  it("overlapping changes cannot finish in reverse order: the stored password is the accepted JWT's change's", async () => {
    // A bumps and is held before its save; B tries to change meanwhile.
    // Before the fix B bumped higher and saved first, then A saved: A's
    // password stood with B's JWT accepted.
    const hold = pauseAt("A", "after version write");
    const h = await raceHarness(engines, [hold]);
    const a = h.change("A", "password-a");
    await hold.reached;
    const b = h.change("B", "password-b");
    await h.doneOrWaiting(b);
    hold.release();
    const jwts: Record<string, string> = { "password-a": await a, "password-b": await b };
    const stored = await h.stored();
    // The invariant: exactly one answer's JWT is accepted, the one of the
    // change whose password is stored; every other JWT is refused.
    const accepted: string[] = [];
    for (const [password, jwt] of Object.entries(jwts)) {
      if (
        await h.jwt.verify(jwt).then(
          () => true,
          () => false,
        )
      )
        accepted.push(password);
    }
    expect(accepted).toEqual([stored.password]);
    await expect(h.jwt.verify(h.before)).rejects.toThrow("Invalid token.");
    // With one transaction per change they ran in order: A, then B (B
    // waited for SQLite's connection), each answer with its own version.
    expect(stored).toEqual({ version: 2, password: "password-b" });
    expect(h.history).toEqual([1, 2]);
    expect(claims(jwts["password-a"] ?? "")).toMatchObject({ id: h.userId, tv: 1 });
    expect(claims(jwts["password-b"] ?? "")).toMatchObject({ id: h.userId, tv: 2 });
    expect(h.logs).toEqual([
      `[auth] password changed: user=${h.userId} tokenVersion=1`,
      `[auth] password changed: user=${h.userId} tokenVersion=2`,
    ]);
  }, 30_000);

  it("a sign-in with the old password between a change's bump and its save keeps no session", async () => {
    const hold = pauseAt("A", "after version write");
    const h = await raceHarness(engines, [hold]);
    const a = h.change("A", "password-a");
    await hold.reached;
    // Before the fix the bump was committed here: the sign-in read the new
    // version next to the old password, and its JWT outlived the change.
    const signIn = h.signIn("old-password");
    signIn.catch(() => undefined);
    await h.doneOrWaiting(signIn);
    hold.release();
    await a;
    const outcome = await signIn.then(
      (jwt) => ({ jwt }),
      (error: Error) => ({ refused: error.message }),
    );
    if ("jwt" in outcome) {
      await expect(h.jwt.verify(outcome.jwt)).rejects.toThrow("Invalid token.");
    } else {
      expect(outcome.refused).toBe("Invalid identifier or password");
    }
    expect(await h.stored()).toEqual({ version: 1, password: "password-a" });
  }, 30_000);

  it("a failed version write fails the change with nothing changed", async () => {
    const h = await raceHarness(engines, [failAt("A", "before version write")]);
    await expect(h.change("A", "password-a")).rejects.toThrow("connection lost");
    expect(await h.stored()).toEqual({ version: 0, password: "old-password" });
    // Nothing changed, so nothing was revoked either.
    await expect(h.jwt.verify(h.before)).resolves.toMatchObject({ id: h.userId });
  }, 30_000);

  it("a failed password write after the bump rolls both back: old password, sessions as they were", async () => {
    const h = await raceHarness(engines, [failAt("A", "before password write")]);
    await expect(h.change("A", "password-a")).rejects.toThrow("connection lost");
    expect(await h.stored()).toEqual({ version: 0, password: "old-password" });
    await expect(h.jwt.verify(h.before)).resolves.toMatchObject({ id: h.userId });
    expect(h.logs).toEqual([
      `[auth] password not changed: user=${h.userId} (the change rolled back: the password and the user's sessions are as they were)`,
    ]);
  }, 30_000);
});

describe("the Document Service guard of the user type (admin-panel passwords, tokenVersion input)", () => {
  /**
   * The Map harness with a fake Document Service for the user type: every
   * update runs through the guard, then writes the (possibly rewritten)
   * data into the row, as the repository would. `userService` is the
   * plugin's edit() as it really is: the user's documentId, then a
   * Document Service update.
   */
  function guardHarness(
    mode: "legacy-support" | "refresh" = "legacy-support",
    createGuard: typeof createUserWriteGuard = createUserWriteGuard,
  ) {
    const h = harness(mode);
    for (const [id, row] of h.users) h.users.set(id, { ...row, documentId: `doc-${id}` });
    const guard = createGuard(h.strapi);
    let failWrite = false;
    const run = async (action: string, params: Record<string, unknown>) => {
      const context = { uid: USER_UID, action, params };
      return guard(context, async () => {
        const final = context.params as { documentId?: string; data: Record<string, unknown> };
        if (failWrite) throw new Error("the Document Service failed");
        h.queries.push(`save ${JSON.stringify(final.data)}`);
        const row = [...h.users.values()].find((user) => user.documentId === final.documentId);
        if (row) h.users.set(row.id, { ...row, ...final.data });
        return final.data;
      });
    };
    const documents = {
      update: (params: { documentId: string; data: Record<string, unknown> }) =>
        run("update", params),
    };
    const userService = patchUserService(
      {
        async edit(id: unknown, params?: unknown) {
          return documents.update({
            documentId: `doc-${String(id)}`,
            data: params as Record<string, unknown>,
          });
        },
      },
      h.strapi,
    );
    const writes = () => h.queries.filter((q) => !q.startsWith("findOne"));
    return {
      ...h,
      guard,
      run,
      documents,
      userService,
      writes,
      failWrites: () => (failWrite = true),
    };
  }

  it("a Content Manager update with a new password raises the version before the write", async () => {
    const h = guardHarness();
    const before = (await h.jwt.issue({ id: 2 })) as string;
    await h.documents.update({ documentId: "doc-2", data: { password: "set-by-an-admin" } });
    expect(h.writes()).toEqual([
      "begin",
      "bump 2",
      `save ${JSON.stringify({ password: "set-by-an-admin" })}`,
      "commit",
    ]);
    expect(h.users.get(2)).toMatchObject({ tokenVersion: 4, password: "set-by-an-admin" });
    await expect(h.jwt.verify(before)).rejects.toThrow("Invalid token.");
    expect(h.logs).toEqual(["[auth] password changed: user=2 tokenVersion=4"]);
  });

  it("an update without a password raises nothing", async () => {
    const h = guardHarness();
    const before = (await h.jwt.issue({ id: 2 })) as string;
    await h.documents.update({ documentId: "doc-2", data: { displayName: "Renamed" } });
    expect(h.writes()).toEqual([`save ${JSON.stringify({ displayName: "Renamed" })}`]);
    expect(h.users.get(2)?.tokenVersion).toBe(3);
    await expect(h.jwt.verify(before)).resolves.toMatchObject({ id: 2 });
    expect(h.logs).toEqual([]);
  });

  it("the user service's edit() path is raised exactly once", async () => {
    const h = guardHarness();
    await h.userService.edit(2, { password: "through-edit" });
    expect(h.writes()).toEqual([
      "begin",
      "bump 2",
      `save ${JSON.stringify({ password: "through-edit" })}`,
      "commit",
    ]);
    expect(h.users.get(2)?.tokenVersion).toBe(4);
    expect(h.logs).toEqual(["[auth] password changed: user=2 tokenVersion=4"]);
  });

  it("is raised once even when the guard comes from a second instance of this module", async () => {
    // Strapi loads the extension by its own path, src/index.ts imports it
    // for register(): two paths to one file can be two module instances.
    vi.resetModules();
    const other = await import("./strapi-server");
    expect(other.createUserWriteGuard).not.toBe(createUserWriteGuard);
    const h = guardHarness("legacy-support", other.createUserWriteGuard);
    await h.userService.edit(2, { password: "through-edit" });
    expect(h.writes()).toEqual([
      "begin",
      "bump 2",
      `save ${JSON.stringify({ password: "through-edit" })}`,
      "commit",
    ]);
  });

  it("an edit() of one user does not cover a Document Service password write of another", async () => {
    const h = guardHarness();
    // A save inside user 2's edit() that writes user 1's password.
    const nested = patchUserService(
      {
        edit: async () => h.documents.update({ documentId: "doc-1", data: { password: "other" } }),
      },
      h.strapi,
    );
    await nested.edit(2, { password: "own" });
    // The nested write joins the outer transaction and still bumps user 1.
    expect(h.writes()).toEqual([
      "begin",
      "bump 2",
      "bump 1",
      `save ${JSON.stringify({ password: "other" })}`,
      "commit",
    ]);
  });

  it("tokenVersion never reaches a write: create, update and clone, with or without a password", async () => {
    const h = guardHarness();
    for (const action of ["create", "update", "clone"]) {
      await h.run(action, { documentId: "doc-1", data: { username: "x", tokenVersion: 0 } });
    }
    expect(h.writes()).toEqual(
      Array.from({ length: 3 }, () => `save ${JSON.stringify({ username: "x" })}`),
    );
    h.queries.length = 0;
    // A password write that tries to set the version back: raised, not reset.
    await h.documents.update({
      documentId: "doc-2",
      data: { password: "p", tokenVersion: 0 },
    });
    expect(h.users.get(2)?.tokenVersion).toBe(4);
    expect(h.logs.filter((line) => line.includes("tokenVersion dropped"))).toHaveLength(4);
  });

  it("leaves other content types and the reading actions alone", async () => {
    const h = guardHarness();
    const seen: unknown[] = [];
    const params = { documentId: "a", data: { password: "p", tokenVersion: 9 } };
    await h.guard({ uid: "api::poll.poll", action: "update", params }, async () =>
      seen.push(params),
    );
    await h.guard({ uid: USER_UID, action: "findOne", params }, async () => seen.push(params));
    expect(seen).toEqual([params, params]);
    expect(h.writes()).toEqual([]);
  });

  it("a failed bump stops the write and rolls back", async () => {
    const h = guardHarness();
    (h.strapi.db.connection as { raw: unknown }).raw = async () => {
      throw new Error("connection lost");
    };
    await expect(
      h.documents.update({ documentId: "doc-2", data: { password: "p" } }),
    ).rejects.toThrow("connection lost");
    expect(h.writes()).toEqual(["begin", "rollback"]);
    expect(h.users.get(2)).toMatchObject({ tokenVersion: 3 });
  });

  it("a failed write after the bump rolls both back: old password, sessions as they were", async () => {
    const h = guardHarness();
    const before = (await h.jwt.issue({ id: 2 })) as string;
    h.failWrites();
    await expect(
      h.documents.update({ documentId: "doc-2", data: { password: "p" } }),
    ).rejects.toThrow("the Document Service failed");
    expect(h.writes()).toEqual(["begin", "bump 2", "rollback"]);
    expect(h.users.get(2)).toMatchObject({ tokenVersion: 3 });
    expect(h.users.get(2)?.password).toBeUndefined();
    await expect(h.jwt.verify(before)).resolves.toMatchObject({ id: 2 });
    expect(h.logs).toEqual([
      "warn [auth] password not changed: user=2 (the change rolled back: the password and the user's sessions are as they were)",
    ]);
  });

  it("refuses a password write for a user it cannot find, before writing", async () => {
    const h = guardHarness();
    await expect(
      h.documents.update({ documentId: "doc-99", data: { password: "p" } }),
    ).rejects.toThrow("cannot be found is refused");
    expect(h.writes()).toEqual([]);
  });

  it("in refresh mode only keeps tokenVersion out", async () => {
    const h = guardHarness("refresh");
    await h.documents.update({ documentId: "doc-2", data: { password: "p", tokenVersion: 0 } });
    expect(h.writes()).toEqual([`save ${JSON.stringify({ password: "p" })}`]);
  });

  it("registerUserWriteGuard hangs it onto the Document Service, or refuses to boot", () => {
    const h = harness();
    const use = vi.fn();
    registerUserWriteGuard({ ...h.strapi, documents: { use } });
    expect(use).toHaveBeenCalledTimes(1);
    expect(() => registerUserWriteGuard({ ...h.strapi, documents: {} })).toThrow(
      "strapi.documents.use not found",
    );
  });
});

describe("the bump inside an ambient transaction (real SQLite)", () => {
  const engines: SqliteEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.close();
  });

  /** The extension's db slice on a real SQLite engine, with its transaction context. */
  async function sqliteStrapi() {
    const engine = await openSqliteEngine([raceUserModel()], { schema: "sync" });
    engines.push(engine);
    const db = engine.db as typeof engine.db & { inTransaction(): boolean };
    const created = await db.query(USER_UID).create({
      data: { username: "casey", password: "old-password", tokenVersion: 0 },
    });
    const strapi = {
      config: { get: (_path: string, fallback?: unknown) => fallback },
      db: {
        query: (uid: string) => db.query(uid),
        connection: db.connection,
        inTransaction: () => db.inTransaction(),
        transaction: db.transaction.bind(db),
        dialect: { client: "sqlite" },
        getSchemaName: () => undefined,
        metadata: db.metadata as unknown as TokenVersionStrapi["db"]["metadata"],
      },
      plugin: () => ({ service: () => undefined }),
    } as unknown as TokenVersionStrapi;
    const stored = async () =>
      Number((await db.query(USER_UID).findOne({ where: { id: created.id } }))?.tokenVersion);
    return { db, strapi, id: created.id as number, stored };
  }

  it("joins the transaction (no wait for SQLite's only connection) and goes with its rollback", async () => {
    const { db, strapi, id, stored } = await sqliteStrapi();
    let inside = 0;
    await expect(
      db.transaction(async () => {
        inside = await bumpTokenVersion(strapi, id);
        throw new Error("the write after the bump failed");
      }),
    ).rejects.toThrow("the write after the bump failed");
    expect(inside).toBe(1);
    expect(await stored()).toBe(0);
    await db.transaction(async () => bumpTokenVersion(strapi, id));
    expect(await stored()).toBe(1);
  }, 10_000);
});

describe("jwtManagement 'refresh': the plugin's own session revocation applies", () => {
  it("passes issue(), verify() and the password actions through untouched", async () => {
    const h = harness("refresh");
    // Stand-ins for the session-manager branch of the plugin's methods.
    const issue = vi.fn(() => "session-token");
    const verify = vi.fn(async () => ({ id: 2, sessionId: "s" }));
    const plugin: UsersPermissionsPlugin = {
      services: { jwt: () => ({ issue, verify }), user: fakeUserFactory() },
      controllers: { auth: fakeAuthFactory() },
    };
    createUsersPermissionsExtension()(plugin);
    const service = (plugin.services.jwt as Factory)({ strapi: h.strapi }) as JwtService;
    const strapi: TokenVersionStrapi = {
      ...h.strapi,
      plugin: () => ({
        service: (name) => (name === "jwt" ? service : h.strapi.plugin("x").service(name)),
      }),
    };
    const auth = (plugin.controllers.auth as Factory)({ strapi }) as Harness["auth"];

    expect(service.issue({ id: 2 })).toBe("session-token");
    await expect(service.verify("x")).resolves.toEqual({ id: 2, sessionId: "s" });
    const ctx = passwordCtx(2);
    await auth.changePassword(ctx);
    expect(ctx.body?.jwt).toBe("session-token");
    expect(h.users.get(2)?.tokenVersion).toBe(3);
    // The password write of the plugin's action, nothing of the extension.
    expect(h.queries).toEqual([
      `update ${JSON.stringify({ where: { id: 2 }, data: { password: "new-password" } })}`,
    ]);
  });
});

describe("the extension itself", () => {
  it("wraps each factory once, also when the plugin module is loaded again (a second boot)", () => {
    const plugin: UsersPermissionsPlugin = {
      services: { jwt: realJwtFactory, user: fakeUserFactory() },
      controllers: { auth: fakeAuthFactory() },
    };
    const extend = createUsersPermissionsExtension();
    extend(plugin);
    const [jwt, user, auth] = [plugin.services.jwt, plugin.services.user, plugin.controllers.auth];
    extend(plugin);
    expect(plugin.services.jwt).toBe(jwt);
    expect(plugin.services.user).toBe(user);
    expect(plugin.controllers.auth).toBe(auth);
  });

  it("refuses to boot when the plugin no longer has the expected shape (upgrade tripwire)", () => {
    const extend = createUsersPermissionsExtension();
    expect(() =>
      extend({
        services: { jwt: {}, user: fakeUserFactory() },
        controllers: { auth: fakeAuthFactory() },
      }),
    ).toThrow("services.jwt is not a factory");
    expect(() =>
      extend({ services: { jwt: realJwtFactory }, controllers: { auth: fakeAuthFactory() } }),
    ).toThrow("services.user is not a factory");
    expect(() =>
      extend({ services: { jwt: realJwtFactory, user: fakeUserFactory() }, controllers: {} }),
    ).toThrow("controllers.auth is not a factory");
    const strapi = harness().strapi;
    const noVerify: UsersPermissionsPlugin = {
      services: { jwt: () => ({ issue: () => "" }), user: () => ({ add: () => undefined }) },
      controllers: { auth: () => ({ changePassword: async () => undefined }) },
    };
    extend(noVerify);
    expect(() => (noVerify.services.jwt as Factory)({ strapi })).toThrow(
      "no longer exposes issue() and verify()",
    );
    expect(() => (noVerify.services.user as Factory)({ strapi })).toThrow(
      "no longer exposes edit()",
    );
    expect(() => (noVerify.controllers.auth as Factory)({ strapi })).toThrow(
      "no longer exposes resetPassword",
    );
  });
});
