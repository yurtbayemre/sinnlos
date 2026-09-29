/**
 * The token-version wrapper of users-permissions (FX40) on the plugin's
 * REAL `jwt` service factory (@strapi/plugin-users-permissions 5.55.1,
 * jsonwebtoken signing and verifying with a test secret) and a fake `auth`
 * controller factory that behaves like the plugin's legacy code for what the
 * wrapper relies on: it puts issue()'s result into ctx.body.jwt without
 * awaiting it, and a refused password change throws. The end-to-end run
 * (the real controller over HTTP) is token-version.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import { cmsPackageDir, requirePackageFile } from "../../test/sqlite-engine.test.helper";
import {
  TOKEN_VERSION_CLAIM,
  USER_UID,
  createUsersPermissionsExtension,
  type AuthContext,
  type JwtService,
  type TokenVersionStrapi,
  type UsersPermissionsPlugin,
} from "./strapi-server";

type Factory = (deps: { strapi: unknown }) => unknown;

/** The plugin's own jwt service factory, as its server index registers it. */
const realJwtFactory = requirePackageFile<{ __require(): Factory }>(
  cmsPackageDir("@strapi/plugin-users-permissions"),
  "dist/server/services/jwt.js",
).__require();

/** The payload of a JWT, unverified. */
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

interface Harness {
  strapi: TokenVersionStrapi;
  users: Map<number, { id: number; tokenVersion?: number | null }>;
  jwt: JwtService;
  auth: Record<string, (ctx: AuthContext, ...rest: unknown[]) => Promise<unknown>>;
  queries: string[];
  logs: string[];
  /** The legacy-support issue() of the plugin itself, unwrapped. */
  rawIssue(payload: object): string;
}

/** A fake auth controller factory with the plugin's legacy behaviour. */
function fakeAuthFactory(): Factory {
  return ({ strapi }) => {
    const jwt = () =>
      (strapi as TokenVersionStrapi).plugin("users-permissions").service("jwt") as JwtService;
    const answer = (ctx: AuthContext, id: number) => {
      // The plugin: ctx.send({ jwt: getService('jwt').issue({ id }), user })
      ctx.body = { jwt: jwt().issue({ id: id }), user: { id, username: `u${id}` } };
    };
    return {
      async callback(ctx: AuthContext & { request: { body: { id: number } } }) {
        answer(ctx, ctx.request.body.id);
      },
      async changePassword(ctx: AuthContext & { request: { body: { currentPassword: string } } }) {
        if (ctx.request.body.currentPassword !== "right") {
          throw new Error("The provided current password is invalid");
        }
        answer(ctx, ctx.state?.user?.id as number);
      },
      async resetPassword(ctx: AuthContext & { request: { body: { id: number } } }) {
        answer(ctx, ctx.request.body.id);
      },
      async logout(ctx: AuthContext) {
        ctx.body = { ok: true };
      },
    };
  };
}

function harness(mode: "legacy-support" | "refresh" = "legacy-support"): Harness {
  const users = new Map<number, { id: number; tokenVersion?: number | null }>([
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
            const id = (args.where as { id: number }).id;
            const row = users.get(id);
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
    },
    plugin: () => ({ service: (name: string) => services[name] }),
    log: { info: (message) => logs.push(message) },
  };
  const plugin: UsersPermissionsPlugin = {
    services: { jwt: realJwtFactory },
    controllers: { auth: fakeAuthFactory() },
  };
  createUsersPermissionsExtension()(plugin);
  services.jwt = (plugin.services.jwt as Factory)({ strapi });
  const auth = (plugin.controllers.auth as Factory)({ strapi }) as Harness["auth"];
  const raw = realJwtFactory({ strapi }) as JwtService;
  return {
    strapi,
    users,
    jwt: services.jwt as JwtService,
    auth,
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
});

describe("jwtManagement 'refresh': the plugin's own session revocation applies", () => {
  it("passes issue(), verify() and the password actions through untouched", async () => {
    const h = harness("refresh");
    // Stand-ins for the session-manager branch of the plugin's methods.
    const issue = vi.fn(() => "session-token");
    const verify = vi.fn(async () => ({ id: 2, sessionId: "s" }));
    const plugin: UsersPermissionsPlugin = {
      services: { jwt: () => ({ issue, verify }) },
      controllers: { auth: fakeAuthFactory() },
    };
    createUsersPermissionsExtension()(plugin);
    const service = (plugin.services.jwt as Factory)({ strapi: h.strapi }) as JwtService;
    const strapi: TokenVersionStrapi = { ...h.strapi, plugin: () => ({ service: () => service }) };
    const auth = (plugin.controllers.auth as Factory)({ strapi }) as Harness["auth"];

    expect(service.issue({ id: 2 })).toBe("session-token");
    await expect(service.verify("x")).resolves.toEqual({ id: 2, sessionId: "s" });
    const ctx = passwordCtx(2);
    await auth.changePassword(ctx);
    expect(ctx.body?.jwt).toBe("session-token");
    expect(h.users.get(2)?.tokenVersion).toBe(3);
    expect(h.queries).toEqual([]);
  });
});

describe("the extension itself", () => {
  it("wraps each factory once, also when the plugin module is loaded again (a second boot)", () => {
    const plugin: UsersPermissionsPlugin = {
      services: { jwt: realJwtFactory },
      controllers: { auth: fakeAuthFactory() },
    };
    const extend = createUsersPermissionsExtension();
    extend(plugin);
    const [jwt, auth] = [plugin.services.jwt, plugin.controllers.auth];
    extend(plugin);
    expect(plugin.services.jwt).toBe(jwt);
    expect(plugin.controllers.auth).toBe(auth);
  });

  it("refuses to boot when the plugin no longer has the expected shape (upgrade tripwire)", () => {
    const extend = createUsersPermissionsExtension();
    expect(() =>
      extend({ services: { jwt: {} }, controllers: { auth: fakeAuthFactory() } }),
    ).toThrow("services.jwt is not a factory");
    expect(() => extend({ services: { jwt: realJwtFactory }, controllers: {} })).toThrow(
      "controllers.auth is not a factory",
    );
    const strapi = harness().strapi;
    const noVerify: UsersPermissionsPlugin = {
      services: { jwt: () => ({ issue: () => "" }) },
      controllers: { auth: () => ({ changePassword: async () => undefined }) },
    };
    extend(noVerify);
    expect(() => (noVerify.services.jwt as Factory)({ strapi })).toThrow(
      "no longer exposes issue() and verify()",
    );
    expect(() => (noVerify.controllers.auth as Factory)({ strapi })).toThrow(
      "no longer exposes resetPassword",
    );
  });
});
