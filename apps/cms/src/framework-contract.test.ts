import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  IncomingMessage,
  ServerResponse,
  createServer as createHttpServer,
  request,
  type RequestListener,
} from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_QUERY_PARAM_KEYS, errors, policy, sanitize, validate } from "@strapi/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import uploadsAuth from "./middlewares/uploads-auth";
import {
  cmsPackageDir,
  openSqliteEngine,
  requireFromPackage,
  requirePackageFile,
  strapiPackageDir,
  strapiPackageVersion,
  type KnexQueryEvent,
  type QueryEngine,
  type SqliteEngine,
} from "./test/sqlite-engine.test.helper";
import { isLocalizedModel } from "./utils/draft-twins";
import { getMutableQuery, restrictiveIdFilter } from "./utils/policy-query";

/**
 * Framework contract (roadmap S04): the Strapi behaviour this cms is built
 * on, pinned against the INSTALLED packages (@strapi/utils, @strapi/core,
 * @strapi/database, @strapi/upload, @strapi/plugin-users-permissions
 * 5.58.0; first pinned on 5.55.1). Each block names the code that relies
 * on it. The utils, core and upload traps run the real modules; the
 * database traps run @strapi/database on a throwaway SQLite file
 * (src/test/sqlite-engine.test.helper.ts), like
 * utils/poll-audience-backfill-sqlite.test.ts.
 *
 * Every test that opens an engine in its body has a 30 s budget: the first
 * one loads @strapi/database and the SQLite driver cold, which can pass the
 * 5 s test default under a full parallel run (§5.40).
 *
 * RUN THIS BEFORE EVERY @strapi/* BUMP. The version pin below fails first on
 * purpose: bump it only after every other block here passes against the new
 * packages, or after the code that relies on a changed behaviour (and its
 * comment) is updated. A block that fails means an assumption of this cms no
 * longer holds, not that the test is wrong.
 */

const STRAPI_VERSION = "5.58.0";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const coreDir = () => strapiPackageDir("@strapi/core");
const upDir = () => cmsPackageDir("@strapi/plugin-users-permissions");

describe("installed versions (bump only after this whole file passes)", () => {
  it.each([
    "@strapi/core",
    "@strapi/utils",
    "@strapi/database",
    "@strapi/strapi",
    "@strapi/upload",
  ])("%s", (name) => {
    expect(strapiPackageVersion(name)).toBe(STRAPI_VERSION);
  });

  it("@strapi/plugin-users-permissions", () => {
    const pkg = requirePackageFile<{ version: string }>(upDir(), "package.json");
    expect(pkg.version).toBe(STRAPI_VERSION);
  });
});

// ---------------------------------------------------------------------------
// @strapi/utils: query sanitizing and validation
// ---------------------------------------------------------------------------

type CoreModel = ReturnType<Parameters<typeof sanitize.createAPISanitizers>[0]["getModel"]>;

const USER_UID = "plugin::users-permissions.user";
const ARTICLE_UID = "api::article.article";

const MODELS: Record<string, unknown> = {
  [USER_UID]: {
    uid: USER_UID,
    modelType: "contentType",
    kind: "collectionType",
    attributes: { username: { type: "string" } },
  },
  [ARTICLE_UID]: {
    uid: ARTICLE_UID,
    modelType: "contentType",
    kind: "collectionType",
    options: { draftAndPublish: true },
    attributes: {
      title: { type: "string" },
      author: { type: "relation", relation: "manyToOne", target: USER_UID },
    },
  },
};

const getModel = (uid: string) => MODELS[uid] as CoreModel;
const article = () => getModel(ARTICLE_UID);

/**
 * The global `strapi` the sanitize/validate visitors read: config for private
 * attributes, and auth.verify for the relation scope checks. `granted` are
 * the scopes the caller holds; every scope asked is recorded.
 */
function stubAuth(granted: readonly string[]) {
  const asked: string[] = [];
  vi.stubGlobal("strapi", {
    config: { get: (_key: string, fallback?: unknown) => fallback },
    auth: {
      verify: async (_auth: unknown, { scope }: { scope: string }) => {
        asked.push(scope);
        if (!granted.includes(scope)) throw new errors.ForbiddenError();
      },
    },
  });
  return { asked, auth: { strategy: { name: "users-permissions" }, credentials: { id: 1 } } };
}

const sanitizers = () => sanitize.createAPISanitizers({ getModel });
const validators = () => validate.createAPIValidators({ getModel });

describe("@strapi/utils sanitizeQuery: empty array operands are stripped (why restrictiveIdFilter exists)", () => {
  it("turns { id: { $in: [] } } into a filter that no longer constrains anything (fail-open)", async () => {
    stubAuth([]);
    const out = await sanitizers().query({ filters: { id: { $in: [] } } }, article(), {});
    expect(out.filters).toEqual({ id: {} });
    const wrapped = await sanitizers().query(
      { filters: { $and: [{ title: { $eq: "x" } }, { id: { $in: [] } }] } },
      article(),
      {},
    );
    expect(wrapped.filters).toEqual({ $and: [{ title: { $eq: "x" } }, { id: {} }] });
  });

  it("keeps the scalar the policies inject for an empty id list (utils/policy-query.ts)", async () => {
    stubAuth([]);
    const injected = restrictiveIdFilter([]);
    expect(injected).toEqual({ id: { $eq: -1 } });
    const out = await sanitizers().query({ filters: injected }, article(), {});
    expect(out.filters).toEqual({ id: { $eq: -1 } });
    const listed = await sanitizers().query(
      { filters: restrictiveIdFilter([3, 4]) },
      article(),
      {},
    );
    expect(listed.filters).toEqual({ id: { $in: [3, 4] } });
  });
});

describe("@strapi/utils + @strapi/core: a client `status` beats the published default (forcePublishedStatus, §5.24)", () => {
  it("validateQuery accepts `status`, sanitizeQuery passes it through verbatim", async () => {
    const { auth } = stubAuth([]);
    expect(ALLOWED_QUERY_PARAM_KEYS).toContain("status");
    await expect(
      validators().query({ status: "draft" }, article(), { auth }),
    ).resolves.toBeUndefined();
    const out = await sanitizers().query(
      { status: "draft", publicationFilter: "never-published" },
      article(),
      {
        auth,
      },
    );
    expect(out).toMatchObject({ status: "draft", publicationFilter: "never-published" });
  });

  it("the core service merges the client params OVER its default", () => {
    const { CoreService } = requirePackageFile<{
      CoreService: new () => {
        getFetchParams(params?: Record<string, unknown>): Record<string, unknown>;
      };
    }>(coreDir(), "dist/core-api/service/core-service.js");
    const service = new CoreService();
    expect(service.getFetchParams({})).toEqual({ status: "published" });
    expect(service.getFetchParams({ status: "draft" })).toEqual({ status: "draft" });
  });
});

describe("@strapi/utils validateQuery: filters through a relation need the target's find scope (§5.16)", () => {
  it("throws 'Invalid key' (a 400) for a relation filter without `<target>.find`", async () => {
    const { auth } = stubAuth([`${USER_UID}.findOne`]);
    const attempt = validators().query({ filters: { author: { id: 1 } } }, article(), { auth });
    await expect(attempt).rejects.toBeInstanceOf(errors.ValidationError);
    await expect(attempt).rejects.toThrow("Invalid key author");
  });

  it("passes the same filter with the find scope, and never checks populate (5.55.1-5.57.0)", async () => {
    const { auth, asked } = stubAuth([`${USER_UID}.find`]);
    await expect(
      validators().query({ filters: { author: { id: 1 } } }, article(), { auth }),
    ).resolves.toBeUndefined();
    expect(asked).toEqual([`${USER_UID}.find`]);

    const denied = stubAuth([]);
    await expect(
      validators().query({ populate: { author: true } }, article(), { auth: denied.auth }),
    ).resolves.toBeUndefined();
    expect(denied.asked).toEqual([]);
  });
});

describe("@strapi/utils sanitize: removeRestrictedRelations checks only the find scope (populate side channel)", () => {
  it("drops a populated relation without `<target>.find`, even with findOne", async () => {
    const { auth, asked } = stubAuth([`${USER_UID}.findOne`]);
    const out = await sanitizers().query({ populate: { author: true } }, article(), { auth });
    expect(out.populate).toEqual({});
    expect(asked).toEqual([`${USER_UID}.find`]);
  });

  it("keeps it with `<target>.find` alone", async () => {
    const { auth } = stubAuth([`${USER_UID}.find`]);
    const out = await sanitizers().query({ populate: { author: true } }, article(), { auth });
    expect(out.populate).toEqual({ author: true });
  });

  it("strips the relation from filters the same way (sanitize runs after validate)", async () => {
    const { auth } = stubAuth([]);
    const out = await sanitizers().filters({ author: { id: 1 }, title: "x" }, article(), { auth });
    expect(out).toEqual({ title: "x" });
  });
});

describe("@strapi/utils createPolicyContext + Koa: only request.query reaches the controller (getMutableQuery, §5.14)", () => {
  interface KoaContext {
    query: Record<string, unknown>;
    request: { query: Record<string, unknown> };
  }
  interface KoaApp {
    createContext(req: IncomingMessage, res: ServerResponse): KoaContext;
  }

  function koaContext(url: string): KoaContext {
    const Koa = requireFromPackage<new () => KoaApp>(coreDir(), "koa");
    const app = new Koa();
    // strapi::query installs the qs parser Strapi uses (cached per querystring).
    const { query } = requirePackageFile<{
      query(config: unknown, deps: { strapi: unknown }): void;
    }>(coreDir(), "dist/middlewares/query.js");
    query({}, { strapi: { server: { app } } });
    const req = new IncomingMessage(new Socket());
    req.url = url;
    req.method = "GET";
    return app.createContext(req, new ServerResponse(req));
  }

  it.each(["/api/polls?filters[title][$eq]=x&status=draft", "/api/polls"])(
    "a write to policyContext.query is lost, one through getMutableQuery lands (%s)",
    (url) => {
      const ctx = koaContext(url);
      const before = JSON.stringify(ctx.query);
      // Typed as a plain object by @strapi/utils; it is ctx's own properties plus is/type.
      const policyContext = policy.createPolicyContext("koa", ctx) as unknown as {
        query?: unknown;
        request: unknown;
      };
      expect(Object.prototype.hasOwnProperty.call(policyContext, "query")).toBe(false);
      expect(policyContext.request).toBe(ctx.request);

      policyContext.query = { filters: { id: { $eq: -1 } } };
      expect(JSON.stringify(ctx.query)).toBe(before);

      const mutable = getMutableQuery(policyContext);
      mutable.filters = { id: { $eq: -1 } };
      mutable.status = "published";
      expect(ctx.query).toBe(mutable);
      expect(ctx.query).toMatchObject({ filters: { id: { $eq: -1 } }, status: "published" });
    },
  );
});

// ---------------------------------------------------------------------------
// @strapi/core: policies, sanitizers registry, strapi::public, D&P, documents
// ---------------------------------------------------------------------------

describe("@strapi/core policies: only `false`-ish results refuse, undefined PASSES (strict booleans)", () => {
  type Middleware = (ctx: unknown, next: () => Promise<void>) => Promise<void>;
  const { createPolicicesMiddleware } = requirePackageFile<{
    createPolicicesMiddleware(
      route: { config?: { policies?: unknown[] } },
      strapi: unknown,
    ): Middleware;
  }>(strapiPackageDir("@strapi/core"), "dist/services/server/policy.js");

  async function passes(result: unknown): Promise<boolean> {
    const strapi = {
      get: (name: string) => {
        if (name !== "policies") throw new Error(name);
        return { resolve: () => [{ handler: () => result, config: {} }] };
      },
    };
    const middleware = createPolicicesMiddleware({ config: { policies: ["global::any"] } }, strapi);
    const next = vi.fn(async () => undefined);
    try {
      await middleware({ state: {}, request: {} }, next);
    } catch (error) {
      expect(error).toBeInstanceOf(errors.PolicyError);
      return false;
    }
    return next.mock.calls.length === 1;
  }

  it.each([
    [true, true],
    [undefined, true],
    [false, false],
    [null, false],
    [0, false],
    ["", false],
    ["yes", false],
    [1, false],
  ])("a policy returning %s passes: %s", async (result, expected) => {
    expect(await passes(result)).toBe(expected);
  });
});

describe("@strapi/core sanitizers registry: add() on an unset path is a silent no-op", () => {
  interface Registry {
    get(path: string): unknown[];
    add(path: string, sanitizer: unknown): Registry;
    set(path: string, value?: unknown[]): Registry;
    has(path: string): boolean;
  }
  const createRegistry = () =>
    requirePackageFile<() => Registry>(
      strapiPackageDir("@strapi/core"),
      "dist/registries/sanitizers.js",
    )();

  it("drops a sanitizer added to a path nobody set (why index.ts uses get()+set())", () => {
    const registry = createRegistry();
    const sanitizer = () => undefined;
    registry.add("content-api.output", sanitizer);
    expect(registry.has("content-api.output")).toBe(false);
    expect(registry.get("content-api.output")).toEqual([]);
  });

  it("keeps it with get()+set(), and add() works once the path exists", () => {
    const registry = createRegistry();
    const first = () => undefined;
    const second = () => undefined;
    registry.set("content-api.output", [...registry.get("content-api.output"), first]);
    registry.add("content-api.output", second);
    expect(registry.get("content-api.output")).toEqual([first, second]);
  });
});

describe("@strapi/core strapi::public and @strapi/upload register routes, mounted after every global middleware (uploads-auth)", () => {
  interface Server {
    app: { callback(): RequestListener };
    use(middleware: unknown): Server;
    mount(): Server;
    listRoutes(): Array<{ path: string }>;
  }
  type Middleware = (ctx: unknown, next: () => Promise<void>) => Promise<void>;

  let publicDir = "";

  function strapiServer() {
    publicDir = mkdtempSync(join(tmpdir(), "sinnlos-public-"));
    mkdirSync(join(publicDir, "uploads"));
    writeFileSync(join(publicDir, "uploads", "secret.pdf"), "%PDF-SECRET");
    writeFileSync(join(publicDir, "robots.txt"), "ROBOTS");
    const strapi: Record<string, unknown> = {
      config: { get: (_key: string, fallback?: unknown) => fallback },
      log: {
        warn: () => undefined,
        info: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      dirs: { static: { public: publicDir } },
      get(name: string) {
        if (name === "policies") return { resolve: () => [] };
        if (name === "middlewares") return { resolve: () => [], get: () => undefined };
        if (name === "auth")
          return {
            authenticate: (_ctx: unknown, next: () => unknown) => next(),
            verify: async () => undefined,
          };
        throw new Error(`strapi.get(${name}) not stubbed`);
      },
    };
    const { createServer } = requirePackageFile<{ createServer(strapi: unknown): Server }>(
      coreDir(),
      "dist/services/server/index.js",
    );
    const server = createServer(strapi);
    strapi.server = server;
    const { publicStatic } = requirePackageFile<{
      publicStatic(config: unknown, deps: { strapi: unknown }): unknown;
    }>(coreDir(), "dist/middlewares/public.js");
    return { server, strapi, publicStatic: () => publicStatic({}, { strapi }) };
  }

  async function fetchPath(server: Server, path: string, headers: Record<string, string> = {}) {
    const http = createHttpServer(server.app.callback());
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        // `path` goes out exactly as written: no client-side dot-segment
        // cleaning. No keep-alive agent, so close() does not wait on it.
        const req = request(
          { host: "127.0.0.1", port, path, method: "GET", headers, agent: false },
          (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  afterEach(() => {
    if (publicDir) rmSync(publicDir, { recursive: true, force: true });
    publicDir = "";
  });

  it("returns no middleware and registers `/` plus the koa-static route instead", () => {
    const { server, publicStatic } = strapiServer();
    expect(publicStatic()).toBeUndefined();
    const paths = server.listRoutes().map((layer) => layer.path);
    expect(paths).toContain("/");
    expect(paths).toContain("/((?!uploads/).+)");
  });

  it("without the gate, `/api/../uploads/<file>` reaches koa-static and serves the bytes (issue #21, K1)", async () => {
    const { server, publicStatic } = strapiServer();
    publicStatic();
    server.mount();
    expect(await fetchPath(server, "/api/../uploads/secret.pdf")).toEqual({
      status: 200,
      body: "%PDF-SECRET",
    });
  });

  it.each(["before", "after"] as const)(
    "uploads-auth as a global middleware protects in any position (%s strapi::public)",
    async (position) => {
      vi.stubEnv("INTERNAL_UPLOAD_TOKEN", "t0k3n");
      const { server, strapi, publicStatic } = strapiServer();
      const gate = uploadsAuth(undefined, { strapi }) as Middleware;
      if (position === "before") server.use(gate);
      publicStatic();
      if (position === "after") server.use(gate);
      server.mount();
      expect(await fetchPath(server, "/api/../uploads/secret.pdf")).toEqual({
        status: 404,
        body: "Not Found",
      });
      expect(await fetchPath(server, "/api/%2e%2e/uploads/secret.pdf")).toMatchObject({
        status: 404,
      });
      // koa-send finds public/uploads under any casing on a case-insensitive
      // file system (Windows, macOS); the gate ignores case too.
      expect(await fetchPath(server, "/api/../UPLOADS/secret.pdf")).toMatchObject({
        status: 404,
      });
      // The web proxy's internal token still gets through; unrelated public files too.
      expect(
        await fetchPath(server, "/api/../uploads/secret.pdf", {
          "x-internal-upload-token": "t0k3n",
        }),
      ).toEqual({
        status: 200,
        body: "%PDF-SECRET",
      });
      expect(await fetchPath(server, "/robots.txt")).toEqual({ status: 200, body: "ROBOTS" });
    },
  );

  /** @strapi/upload's register() hands the direct `/uploads/(.*)` to this (CJS default export). */
  const registerUploadRoute = (strapi: unknown) =>
    requirePackageFile<(deps: { strapi: unknown }) => void>(
      strapiPackageDir("@strapi/upload"),
      "dist/server/middlewares/upload.js",
    )({ strapi });

  it("@strapi/upload serves the direct `/uploads/(.*)` through a route, not app.use", async () => {
    const { server, strapi } = strapiServer();
    registerUploadRoute(strapi);
    // A route on the router, not an app.use middleware (which would run
    // wherever the plugin's register phase put it, before the global ones).
    expect(server.listRoutes().map((layer) => layer.path)).toContain("/uploads/(.*)");
    server.mount();
    expect(await fetchPath(server, "/uploads/secret.pdf")).toEqual({
      status: 200,
      body: "%PDF-SECRET",
    });
  });

  it.each(["before", "after"] as const)(
    "uploads-auth protects the upload plugin's direct path in any position (%s @strapi/upload)",
    async (position) => {
      vi.stubEnv("INTERNAL_UPLOAD_TOKEN", "t0k3n");
      const { server, strapi } = strapiServer();
      const gate = uploadsAuth(undefined, { strapi }) as Middleware;
      if (position === "before") server.use(gate);
      registerUploadRoute(strapi);
      if (position === "after") server.use(gate);
      server.mount();
      for (const path of ["/uploads/secret.pdf", "/UPLOADS/secret.pdf"]) {
        expect(await fetchPath(server, path), path).toEqual({ status: 404, body: "Not Found" });
      }
      expect(
        await fetchPath(server, "/uploads/secret.pdf", { "x-internal-upload-token": "t0k3n" }),
      ).toEqual({ status: 200, body: "%PDF-SECRET" });
    },
  );

  it("mounts the router after all global middlewares (services/server/index.js mount)", () => {
    const source = readFileSync(join(coreDir(), "dist/services/server/index.js"), "utf8");
    expect(source).toMatch(/mount \(\) \{[\s\S]*?app\.use\(router\.routes\(\)\)/);
  });
});

describe("@strapi/core: turning draft & publish off deletes drafts in beforeSync, outside any transaction", () => {
  const NOTE = "api::note.note";
  const NOTE_MODEL = {
    uid: NOTE,
    singularName: "note",
    tableName: "notes",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      title: { type: "string" },
      publishedAt: { type: "datetime" },
    },
  };
  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it("deletes every row with published_at NULL, as a plain autocommit statement", async () => {
    engine = await openSqliteEngine([NOTE_MODEL]);
    const { db } = engine;
    await db.query(NOTE).create({ data: { documentId: "a", title: "draft", publishedAt: null } });
    await db
      .query(NOTE)
      .create({ data: { documentId: "a", title: "published", publishedAt: new Date() } });
    await db
      .query(NOTE)
      .create({ data: { documentId: "b", title: "draft only", publishedAt: null } });

    const statements: KnexQueryEvent[] = [];
    const listener = (event: KnexQueryEvent) => statements.push(event);
    db.connection.on("query", listener);
    const transaction = vi.spyOn(db, "transaction");
    const { disable } = requirePackageFile<{
      disable(args: {
        oldContentTypes: Record<string, unknown>;
        contentTypes: Record<string, unknown>;
      }): Promise<void>;
    }>(coreDir(), "dist/migrations/draft-publish.js");
    await disable({
      oldContentTypes: { [NOTE]: { options: { draftAndPublish: true } } },
      contentTypes: { [NOTE]: { options: { draftAndPublish: false } } },
    });
    db.connection.off("query", listener);

    expect((await db.query(NOTE).findMany({ select: ["title"] })).map((row) => row.title)).toEqual([
      "published",
    ]);
    // One bare DELETE: no strapi.db.transaction, no BEGIN/SAVEPOINT around it,
    // so it commits on its own even if the schema sync after it fails.
    expect(transaction).not.toHaveBeenCalled();
    expect(statements.map((event) => event.sql)).toEqual([
      "delete from `notes` where (`published_at` is null)",
    ]);
  }, 30_000);

  it("is wired to beforeSync, which Strapi calls before db.schema.sync()", () => {
    const registries = readFileSync(join(coreDir(), "dist/providers/registries.js"), "utf8");
    expect(registries).toMatch(
      /hook\('strapi::content-types\.beforeSync'\)\.register\([\w$]+\.disable\)/,
    );
    const migrations = readFileSync(join(coreDir(), "dist/migrations/index.js"), "utf8");
    expect(migrations).toMatch(/const disable = [\s\S]*?draftPublish\.disable\(/);
    const boot = readFileSync(join(coreDir(), "dist/Strapi.js"), "utf8");
    const beforeSync = boot.indexOf("hook('strapi::content-types.beforeSync').call(");
    const sync = boot.indexOf("await this.db.schema.sync()");
    expect(beforeSync).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(beforeSync);
  });

  it("C25: the user register() runs before db.init and the beforeSync hook (the org and revision guards)", () => {
    const boot = readFileSync(join(coreDir(), "dist/Strapi.js"), "utf8");
    // load(): register() completes before bootstrap() starts.
    expect(boot).toMatch(
      /async load\(\) \{\s*await this\.register\(\);\s*await this\.bootstrap\(\);/,
    );
    const register = boot.indexOf("async register() {");
    const userRegister = boot.indexOf(
      "await this.runUserLifecycles(lifecycles.LIFECYCLES.REGISTER)",
    );
    const bootstrap = boot.indexOf("async bootstrap() {");
    const init = boot.indexOf("await this.db.init(");
    const beforeSync = boot.indexOf("hook('strapi::content-types.beforeSync').call(");
    expect(register).toBeGreaterThan(-1);
    expect(userRegister).toBeGreaterThan(register);
    expect(bootstrap).toBeGreaterThan(userRegister);
    expect(init).toBeGreaterThan(bootstrap);
    expect(beforeSync).toBeGreaterThan(init);
  });
});

describe("@strapi/core document service over @strapi/database (SQLite)", () => {
  const NOTE = "api::note.note";
  /** A content type as the registry hands it to the document service. */
  const NOTE_TYPE = {
    uid: NOTE,
    modelType: "contentType",
    kind: "collectionType",
    modelName: "note",
    globalId: "Note",
    collectionName: "notes",
    info: { singularName: "note", pluralName: "notes", displayName: "Note" },
    options: { draftAndPublish: true },
    attributes: {
      title: { type: "string" },
      body: { type: "text" },
      createdAt: { type: "datetime" },
      updatedAt: { type: "datetime" },
      publishedAt: { type: "datetime", configurable: false, writable: true, visible: false },
      locale: { type: "string" },
    },
  };

  interface DocumentEntry {
    id: number;
    documentId: string;
    title?: string | null;
    body?: string | null;
    publishedAt?: unknown;
  }
  interface Documents {
    create(params: Record<string, unknown>): Promise<DocumentEntry>;
    update(params: Record<string, unknown>): Promise<DocumentEntry | null>;
    findMany(params?: Record<string, unknown>): Promise<DocumentEntry[]>;
    findOne(params: Record<string, unknown>): Promise<DocumentEntry | null>;
    publish(params: Record<string, unknown>): Promise<{ entries: DocumentEntry[] }>;
    unpublish(params: Record<string, unknown>): Promise<{ entries: DocumentEntry[] }>;
    discardDraft(params: Record<string, unknown>): Promise<{ entries: DocumentEntry[] }>;
    clone(
      params: Record<string, unknown>,
    ): Promise<{ documentId: string; entries: DocumentEntry[] }>;
    delete(params: Record<string, unknown>): Promise<{ entries: unknown[] }>;
  }

  /** What a Document Service middleware receives (C4). */
  interface MiddlewareContext {
    uid: string;
    action: string;
    params: Record<string, unknown>;
    contentType: { uid: string };
  }
  type Middleware = (context: MiddlewareContext, next: () => Promise<unknown>) => Promise<unknown>;

  /** createDocumentService's result: the factory plus `use` (strapi.documents). */
  type DocumentServiceFactory = ((uid: string) => Documents) & {
    use(middleware: Middleware): () => void;
  };

  interface Localization {
    register(provider: unknown): void;
    isEnabled(): boolean;
    isLocalizedContentType(model: unknown): boolean;
    getDefaultLocale(): Promise<string | null>;
  }

  /**
   * strapi.localization as a booted app has it (5.57+, strapi#27806): core's
   * capability (services/localization.js) with @strapi/i18n's provider
   * registered, as i18n's register() does on every boot (i18n is an internal
   * plugin, loaders/plugins/get-enabled-plugins.js). Both are the real
   * modules; the provider asks the real i18n content-types service
   * (pluginOptions.i18n.localized). Only the locales service is stubbed: its
   * default locale lives in the core store, and nothing reads it for a type
   * that is not localized.
   */
  function i18nLocalization(fake: Record<string, unknown>): Localization {
    const i18nDir = strapiPackageDir("@strapi/i18n");
    const contentTypesService = requirePackageFile<() => unknown>(
      i18nDir,
      "dist/server/services/content-types.js",
    )();
    const localesService = {
      getDefaultLocale: async () => "en",
      find: async () => [{ code: "en", name: "English (en)" }],
    };
    fake.plugin = (name: string) =>
      name === "i18n"
        ? {
            service: (service: string) => {
              if (service === "content-types") return contentTypesService;
              if (service === "locales") return localesService;
              throw new Error(`i18n service ${service} not stubbed`);
            },
          }
        : undefined;
    const { createLocalizationService } = requirePackageFile<{
      createLocalizationService(): Localization;
    }>(coreDir(), "dist/services/localization.js");
    const { createLocalizationProvider } = requirePackageFile<{
      createLocalizationProvider(strapi: unknown): unknown;
    }>(i18nDir, "dist/server/localization.js");
    const localization = createLocalizationService();
    localization.register(createLocalizationProvider(fake));
    return localization;
  }

  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  async function documents(): Promise<{ docs: Documents; db: QueryEngine }> {
    const { service, db } = await documentService([NOTE_TYPE]);
    return { docs: service(NOTE), db };
  }

  /**
   * The real document service (@strapi/core createDocumentService) over the
   * real query engine on SQLite, for `types`; `service.use` is
   * `strapi.documents.use`.
   */
  async function documentService(
    types: ReadonlyArray<{ uid: string }>,
  ): Promise<{ service: DocumentServiceFactory; db: QueryEngine }> {
    const { transformContentTypesToModels } = requirePackageFile<{
      transformContentTypesToModels(contentTypes: unknown[], identifiers: unknown): unknown[];
    }>(coreDir(), "dist/utils/transform-content-types-to-models.js");
    engine = await openSqliteEngine((identifiers) =>
      transformContentTypesToModels([...types], identifiers),
    );
    const { db } = engine;
    const contentTypes: Record<string, unknown> = Object.fromEntries(
      types.map((type) => [type.uid, type]),
    );
    const fake: Record<string, unknown> = {
      db,
      contentTypes,
      components: {},
      contentType: (uid: string) => contentTypes[uid],
      getModel: (uid: string) => contentTypes[uid],
      config: { get: (_key: string, fallback?: unknown) => fallback },
      eventHub: { emit: async () => undefined },
      log: {
        warn: () => undefined,
        info: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    };
    // i18n is always installed; this type is not localized.
    const localization = i18nLocalization(fake);
    fake.localization = localization;
    const queryParams = requirePackageFile<(strapi: unknown) => unknown>(
      coreDir(),
      "dist/services/query-params.js",
    )(fake);
    fake.get = (name: string) => {
      if (name === "query-params") return queryParams;
      if (name === "localization") return localization;
      throw new Error(`strapi.get(${name}) not stubbed`);
    };
    vi.stubGlobal("strapi", fake);
    const { createDocumentService } = requirePackageFile<{
      createDocumentService(strapi: unknown): DocumentServiceFactory;
    }>(coreDir(), "dist/services/document-service/index.js");
    const service = createDocumentService(fake);
    fake.documents = service;
    return { service, db };
  }

  it("asks i18n's provider through strapi.localization: only pluginOptions.i18n.localized localizes (draft-twins.ts)", async () => {
    const localization = i18nLocalization({});
    expect(localization.isEnabled()).toBe(true);
    const localized = { ...NOTE_TYPE, pluginOptions: { i18n: { localized: true } } };
    expect(localization.isLocalizedContentType(NOTE_TYPE)).toBe(false);
    expect(localization.isLocalizedContentType(localized)).toBe(true);
    // utils/draft-twins.ts mirrors this test for its locale handling.
    expect(isLocalizedModel(NOTE_TYPE)).toBe(false);
    expect(isLocalizedModel(localized)).toBe(true);
    expect(await localization.getDefaultLocale()).toBe("en");
    // Without a provider core answers "not localized" on its own.
    const { createLocalizationService } = requirePackageFile<{
      createLocalizationService(): Localization;
    }>(coreDir(), "dist/services/localization.js");
    expect(createLocalizationService().isLocalizedContentType(localized)).toBe(false);
  });

  it("publishing keeps a draft row and a published row with different ids (§5.17, §5.36)", async () => {
    const { docs, db } = await documents();
    const published = await docs.create({ data: { title: "T", body: "B" }, status: "published" });
    const rows = (await db
      .query(NOTE)
      .findMany({ orderBy: { id: "asc" } })) as unknown as DocumentEntry[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.documentId)).toEqual([published.documentId, published.documentId]);
    expect(rows[0].publishedAt).toBeNull();
    expect(rows[1]).toMatchObject({ id: published.id, title: "T", body: "B" });
    expect(rows[0].id).not.toBe(rows[1].id);
  }, 30_000);

  it("a status taken from the client params reads the draft rows", async () => {
    const { docs } = await documents();
    const created = await docs.create({ data: { title: "Draft only" } });
    expect(await docs.findMany({ status: "published" })).toEqual([]);
    expect((await docs.findMany({ status: "draft" })).map((row) => row.id)).toEqual([created.id]);
  }, 30_000);

  it("updating a published-only document writes a draft from the payload ONLY (FX38 root cause)", async () => {
    const { docs, db } = await documents();
    const published = await docs.create({ data: { title: "T", body: "B" }, status: "published" });
    // A published-only document: the state a db.query seed used to leave behind.
    await db.query(NOTE).delete({ where: { documentId: published.documentId, publishedAt: null } });

    // The Content Manager and the REST update both land here.
    const draft = await docs.update({ documentId: published.documentId, data: { title: "T2" } });
    expect(draft).toMatchObject({
      documentId: published.documentId,
      title: "T2",
      body: null,
      publishedAt: null,
    });
    expect(draft?.id).not.toBe(published.id);
    const rows = (await db
      .query(NOTE)
      .findMany({ orderBy: { id: "asc" } })) as unknown as DocumentEntry[];
    expect(rows.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "T", body: "B" },
      { title: "T2", body: null },
    ]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Batch 15 (decision 06 §D, §F, §G, §K), re-pinned on 5.57.0 (plan item 0):
  // the document layer's middlewares (bootstrap/document-middlewares.ts),
  // the lock (utils/document-lock.ts), schedule-clear, publish readiness and
  // the audit recorder are built on these.

  const TAG = "api::tag.tag";
  const MEMO = "api::memo.memo";
  const draftAndPublishType = (
    uid: string,
    singular: string,
    plural: string,
    attributes: Record<string, unknown>,
  ) => ({
    uid,
    modelType: "contentType",
    kind: "collectionType",
    modelName: singular,
    globalId: singular[0].toUpperCase() + singular.slice(1),
    collectionName: plural,
    info: { singularName: singular, pluralName: plural, displayName: singular },
    options: { draftAndPublish: true },
    attributes: {
      ...attributes,
      createdAt: { type: "datetime" },
      updatedAt: { type: "datetime" },
      publishedAt: { type: "datetime", configurable: false, writable: true, visible: false },
      locale: { type: "string" },
    },
  });
  const TAG_TYPE = draftAndPublishType(TAG, "tag", "tags", { title: { type: "string" } });
  /** A memo links a tag (to-one), like lesson.course and wiki-page.parent. */
  const MEMO_TYPE = draftAndPublishType(MEMO, "memo", "memos", {
    title: { type: "string" },
    body: { type: "text" },
    tag: { type: "relation", relation: "manyToOne", target: TAG },
  });

  /** A recording middleware: `<name> <before|after> <action>`. */
  const recorder =
    (name: string, log: string[]): Middleware =>
    async (context, next) => {
      log.push(`${name} before ${context.action}`);
      const result = await next();
      log.push(`${name} after ${context.action}`);
      return result;
    };

  const rowsOf = async (db: QueryEngine, uid: string, documentId: string) =>
    (await db.query(uid).findMany({
      where: { documentId },
      orderBy: { id: "asc" },
      populate: uid === MEMO ? { tag: { select: ["documentId"] } } : undefined,
    })) as unknown as Array<DocumentEntry & { tag?: { documentId: string } | null }>;

  it("C4: middlewares run in registration order, first registered outermost, with ONE context object {uid, contentType, action, params}", async () => {
    const { service } = await documentService([NOTE_TYPE]);
    const log: string[] = [];
    const seen: MiddlewareContext[] = [];
    service.use(async (context, next) => {
      seen.push(context);
      return recorder("first", log)(context, next);
    });
    service.use(async (context, next) => {
      seen.push(context);
      return recorder("second", log)(context, next);
    });
    await service(NOTE).create({ data: { title: "T" } });
    expect(log).toEqual([
      "first before create",
      "second before create",
      "second after create",
      "first after create",
    ]);
    // The same object reaches every middleware of one action (the lock hands
    // the audit recorder its revision through it, utils/document-lock.ts).
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(Object.keys(seen[0]).sort()).toEqual(["action", "contentType", "params", "uid"]);
    expect(seen[0]).toMatchObject({ uid: NOTE, action: "create", contentType: { uid: NOTE } });
  }, 30_000);

  it("C4: the action runs with ctx.params as the middlewares leave it (schedule-clear edits data)", async () => {
    const { service } = await documentService([NOTE_TYPE]);
    service.use(async (context, next) => {
      const data = context.params.data as Record<string, unknown>;
      context.params.data = { ...data, body: "set by a middleware" };
      return next();
    });
    const created = await service(NOTE).create({ data: { title: "T", body: "client" } });
    expect(created).toMatchObject({ title: "T", body: "set by a middleware" });
  }, 30_000);

  it("C3: create and update with status 'published' publish inside the action, without a publish pass through the chain", async () => {
    const { service, db } = await documentService([NOTE_TYPE]);
    const actions: string[] = [];
    service.use(async (context, next) => {
      actions.push(context.action);
      return next();
    });
    const created = await service(NOTE).create({ data: { title: "T" }, status: "published" });
    expect(actions).toEqual(["create"]);
    const createdRows = await rowsOf(db, NOTE, created.documentId);
    expect(createdRows.map((row) => row.publishedAt === null)).toEqual([true, false]);
    actions.length = 0;
    await service(NOTE).update({
      documentId: created.documentId,
      data: { title: "T2" },
      status: "published",
    });
    expect(actions).toEqual(["update"]);
    const rows = await rowsOf(db, NOTE, created.documentId);
    expect(rows.map((row) => row.title)).toEqual(["T2", "T2"]);
  }, 30_000);

  it("C28: a direct create or update without a status saves the draft only", async () => {
    const { service, db } = await documentService([NOTE_TYPE]);
    const draft = await service(NOTE).create({ data: { title: "D" } });
    expect(await rowsOf(db, NOTE, draft.documentId)).toEqual([
      expect.objectContaining({ title: "D", publishedAt: null }),
    ]);
    const published = await service(NOTE).create({ data: { title: "P" }, status: "published" });
    await service(NOTE).update({ documentId: published.documentId, data: { title: "P2" } });
    const rows = await rowsOf(db, NOTE, published.documentId);
    expect(rows.map((row) => [row.title, row.publishedAt === null])).toEqual([
      ["P2", true],
      ["P", false],
    ]);
  }, 30_000);

  it("C5/C8: an action joins the transaction a middleware opened and rolls back with it; inTransaction() tells", async () => {
    const { service, db } = await documentService([NOTE_TYPE]);
    const engineDb = db as unknown as { inTransaction(): boolean };
    const inside: boolean[] = [];
    service.use(async (context, next) =>
      db.transaction(async () => {
        inside.push(engineDb.inTransaction());
        const result = await next();
        if (context.action === "create") throw new Error("refused after the write");
        return result;
      }),
    );
    expect(engineDb.inTransaction()).toBe(false);
    await expect(service(NOTE).create({ data: { title: "Rolled back" } })).rejects.toThrow(
      "refused after the write",
    );
    expect(inside).toEqual([true]);
    expect(await db.query(NOTE).count({})).toBe(0);
  }, 30_000);

  it("C29: `fields` takes scalar attributes only; a relation key throws", async () => {
    const { service } = await documentService([TAG_TYPE, MEMO_TYPE]);
    const created = await service(MEMO).create({ data: { title: "M" }, fields: ["title"] });
    expect(created).toMatchObject({ title: "M" });
    expect(created).not.toHaveProperty("body");
    await expect(service(MEMO).create({ data: { title: "M" }, fields: ["tag"] })).rejects.toThrow(
      errors.ValidationError,
    );
  }, 30_000);

  it("C20: unpublish deletes the published rows; a discard afterwards deletes the whole document", async () => {
    const { service, db } = await documentService([NOTE_TYPE]);
    const created = await service(NOTE).create({ data: { title: "T" }, status: "published" });
    const unpublished = await service(NOTE).unpublish({ documentId: created.documentId });
    expect(unpublished.entries).toHaveLength(1);
    expect(await rowsOf(db, NOTE, created.documentId)).toEqual([
      expect.objectContaining({ publishedAt: null }),
    ]);
    const discarded = await service(NOTE).discardDraft({ documentId: created.documentId });
    expect(discarded.entries).toEqual([]);
    expect(await rowsOf(db, NOTE, created.documentId)).toEqual([]);
  }, 30_000);

  it("C23: publish silently drops a link to a target without a published row", async () => {
    const { service, db } = await documentService([TAG_TYPE, MEMO_TYPE]);
    const draftTag = await service(TAG).create({ data: { title: "draft-only tag" } });
    const memo = await service(MEMO).create({
      data: { title: "M", tag: draftTag.documentId },
    });
    await expect(service(MEMO).publish({ documentId: memo.documentId })).resolves.toBeDefined();
    const [draft, published] = await rowsOf(db, MEMO, memo.documentId);
    expect(draft.tag).toMatchObject({ documentId: draftTag.documentId });
    expect(published.publishedAt).not.toBeNull();
    expect(published.tag ?? null).toBeNull();
    // With a published target the link survives the publish.
    await service(TAG).publish({ documentId: draftTag.documentId });
    await service(MEMO).publish({ documentId: memo.documentId });
    const [, republished] = await rowsOf(db, MEMO, memo.documentId);
    expect(republished.tag).toMatchObject({ documentId: draftTag.documentId });
  }, 30_000);

  it("C35: clone copies the draft and merges `data` over the copy (null included)", async () => {
    const { service, db } = await documentService([NOTE_TYPE]);
    const source = await service(NOTE).create({ data: { title: "Src", body: "keep?" } });
    const actions: string[] = [];
    service.use(async (context, next) => {
      actions.push(context.action);
      return next();
    });
    const cloned = await service(NOTE).clone({
      documentId: source.documentId,
      data: { body: null },
    });
    expect(actions).toEqual(["clone"]);
    expect(cloned.documentId).not.toBe(source.documentId);
    expect(await rowsOf(db, NOTE, cloned.documentId)).toEqual([
      expect.objectContaining({ title: "Src", body: null, publishedAt: null }),
    ]);
    expect(await rowsOf(db, NOTE, source.documentId)).toEqual([
      expect.objectContaining({ title: "Src", body: "keep?" }),
    ]);
  }, 30_000);

  // --- Batch 16, lane 16D (DA03): what the wiki-revision flip, its rollback
  // and the after-image lifecycle rely on.

  /** A type without draft & publish, as wiki-revision is from batch 16 on. */
  const LOG = "api::log.log";
  const LOG_TYPE = {
    ...NOTE_TYPE,
    uid: LOG,
    modelName: "log",
    globalId: "Log",
    collectionName: "logs",
    info: { singularName: "log", pluralName: "logs", displayName: "Log" },
    options: { draftAndPublish: false },
  };

  it("C26: turning draft & publish ON clones every PUBLISHED row once, as a draft, through discardDraft (the rollback twins)", async () => {
    const { service, db } = await documentService([NOTE_TYPE]);
    const actions: string[] = [];
    service.use(async (context, next) => {
      actions.push(`${context.action} ${String(context.params.documentId)}`);
      return next();
    });
    // The rows a draft & publish OFF model wrote: published, one per document.
    const sources = [
      ["rev1", "first"],
      ["rev2", "second"],
    ] as const;
    for (const [documentId, title] of sources) {
      await db.query(NOTE).create({ data: { documentId, title, publishedAt: new Date() } });
    }
    // A row without published_at (what the batch-16 guard refuses) is not cloned.
    await db
      .query(NOTE)
      .create({ data: { documentId: "rev3", title: "draft", publishedAt: null } });
    const { enable } = requirePackageFile<{
      enable(args: {
        oldContentTypes: Record<string, unknown>;
        contentTypes: Record<string, unknown>;
      }): Promise<void>;
    }>(coreDir(), "dist/migrations/draft-publish.js");
    await enable({
      oldContentTypes: { [NOTE]: { ...NOTE_TYPE, options: { draftAndPublish: false } } },
      contentTypes: { [NOTE]: NOTE_TYPE },
    });
    expect(actions.sort()).toEqual(["discardDraft rev1", "discardDraft rev2"]);
    for (const [documentId, title] of sources) {
      const rows = await rowsOf(db, NOTE, documentId);
      expect(rows.map((row) => [row.title, row.publishedAt === null])).toEqual([
        [title, false],
        [title, true],
      ]);
    }
    expect(await rowsOf(db, NOTE, "rev3")).toEqual([
      expect.objectContaining({ title: "draft", publishedAt: null }),
    ]);
    // The enable hook is wired to afterSync (the rollback image's first boot).
    const registries = readFileSync(join(coreDir(), "dist/providers/registries.js"), "utf8");
    expect(registries).toMatch(
      /hook\('strapi::content-types\.afterSync'\)\.register\([\w$]+\.enable\)/,
    );
    const batches = readFileSync(
      join(coreDir(), "dist/migrations/database/5.0.0-discard-drafts.js"),
      "utf8",
    );
    expect(batches).toMatch(
      /async function\* getBatchToDiscard[\s\S]*?publishedAt: \{\s*\$ne: null\s*\}/,
    );
  }, 30_000);

  it("S4: a Document Service write of a type without draft & publish sets publishedAt; a db.query create does not", async () => {
    const { service, db } = await documentService([LOG_TYPE]);
    const created = await service(LOG).create({ data: { title: "via documents" } });
    await service(LOG).update({ documentId: created.documentId, data: { title: "updated" } });
    const raw = await db.query(LOG).create({ data: { title: "via db.query" } });
    const rows = (await db
      .query(LOG)
      .findMany({ orderBy: { id: "asc" } })) as unknown as DocumentEntry[];
    expect(rows.map((row) => [row.title, row.publishedAt !== null])).toEqual([
      ["updated", true],
      ["via db.query", false],
    ]);
    // db.query still gives the row a documentId (the model's default).
    expect(typeof (raw as unknown as DocumentEntry).documentId).toBe("string");
  }, 30_000);

  it("the lifecycles the after-image relies on: one event state per update; publish and discard create rows, never update the draft", async () => {
    const events: string[] = [];
    const status = (row: unknown) =>
      (row as DocumentEntry | null)?.publishedAt == null ? "draft" : "published";
    const lifecycles = {
      async beforeUpdate(event: { state: Record<string, unknown> }) {
        event.state.mark = "kept";
      },
      async afterUpdate(event: { state: Record<string, unknown>; result: unknown }) {
        events.push(`afterUpdate ${status(event.result)} state=${String(event.state.mark)}`);
      },
      async afterCreate(event: { state: Record<string, unknown>; result: unknown }) {
        events.push(`afterCreate ${status(event.result)} state=${String(event.state.mark)}`);
      },
    };
    const typeWithLifecycles: { uid: string } = { ...NOTE_TYPE, lifecycles } as { uid: string };
    const { service } = await documentService([typeWithLifecycles]);
    const created = await service(NOTE).create({ data: { title: "v1" } });
    await service(NOTE).update({ documentId: created.documentId, data: { title: "v2" } });
    await service(NOTE).publish({ documentId: created.documentId });
    await service(NOTE).update({ documentId: created.documentId, data: { title: "v3" } });
    await service(NOTE).discardDraft({ documentId: created.documentId });
    expect(events).toEqual([
      "afterCreate draft state=undefined",
      "afterUpdate draft state=kept",
      "afterCreate published state=undefined",
      "afterUpdate draft state=kept",
      "afterCreate draft state=undefined",
    ]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// @strapi/database on SQLite: schema sync and the query engine
// ---------------------------------------------------------------------------

describe("@strapi/database schema sync (datetime contract, decision 04)", () => {
  const THING = "api::thing.thing";
  const thingModel = (extra: Record<string, unknown> = {}) => ({
    uid: THING,
    singularName: "thing",
    tableName: "things",
    attributes: {
      id: { type: "increments" },
      name: { type: "string" },
      happenedAt: { type: "datetime" },
      ...extra,
    },
  });
  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  interface SchemaColumn {
    name: string;
    type: string;
    args: unknown[];
    notNullable?: boolean;
    defaultTo?: unknown;
  }

  interface PgKnex {
    schema: {
      createTable(table: string, build: (table: PgTableBuilder) => void): { toString(): string };
      alterTable(table: string, build: (table: PgTableBuilder) => void): { toString(): string };
    };
    destroy(): Promise<void>;
  }
  interface PgColumn {
    nullable(): PgColumn;
    notNullable(): PgColumn;
    alter(): PgColumn;
  }
  type PgTableBuilder = Record<string, (name: string, ...args: unknown[]) => PgColumn>;

  /** knex (as @strapi/database resolves it) rendering Postgres DDL without a server. */
  function pgKnex(): PgKnex {
    const databaseDir = strapiPackageDir("@strapi/database");
    return requireFromPackage<(config: Record<string, unknown>) => PgKnex>(
      databaseDir,
      "knex",
    )({ client: "pg" });
  }

  /** The column as builder.js createColumn hands it to knex: tableBuilder[type](name, ...args). */
  function renderColumn(table: PgTableBuilder, column: SchemaColumn): PgColumn {
    const built = table[column.type](column.name, ...column.args);
    return column.notNullable ? built.notNullable() : built.nullable();
  }

  it("creates every datetime column naive: useTz false, timestamp(6) without time zone", async () => {
    engine = await openSqliteEngine([thingModel()]);
    const schema = engine.db.schema.schema as {
      tables: Array<{ name: string; columns: SchemaColumn[] }>;
    };
    const column = schema.tables
      .find((table) => table.name === "things")
      ?.columns.find((c) => c.name === "happened_at");
    expect(column).toMatchObject({ type: "datetime", args: [{ useTz: false, precision: 6 }] });

    const pg = pgKnex();
    try {
      const ddl = pg.schema
        .createTable("things", (table) => renderColumn(table, column as SchemaColumn))
        .toString();
      expect(ddl).toBe('create table "things" ("happened_at" timestamp(6) null)');
    } finally {
      await pg.destroy();
    }
  }, 30_000);

  it("with forceMigration false a sync keeps the column of an attribute the model lost (a rollback keeps the batch-16 revision columns)", async () => {
    engine = await openSqliteEngine([thingModel({ pageDocumentId: { type: "string" } })], {
      schema: "sync",
    });
    await engine.db.connection.raw(
      "insert into things (name, page_document_id) values ('x', 'p1')",
    );
    const db = await engine.reopen([thingModel()]);
    expect(await db.schema.sync()).toBe("CHANGED");
    expect(await db.connection.schema.hasColumn("things", "page_document_id")).toBe(true);
    expect(await db.connection.raw("select page_document_id from things")).toEqual([
      { page_document_id: "p1" },
    ]);
  }, 30_000);

  it("re-syncs an unchanged model without touching the column", async () => {
    engine = await openSqliteEngine([thingModel()], { schema: "sync" });
    const db = await engine.reopen([thingModel()]);
    expect(await db.schema.sync()).toBe("UNCHANGED");
  }, 30_000);

  it("a `column` override on a datetime attribute forces .alter(), which recreates the column naive", async () => {
    engine = await openSqliteEngine([thingModel()], { schema: "sync" });
    const overridden = thingModel({
      happenedAt: { type: "datetime", column: { notNullable: true, defaultTo: "2026-01-01" } },
    });
    const db = await engine.reopen([overridden]);
    const stored = await db.schema.schemaStorage.read();
    const { status, diff } = await db.schema.schemaDiff.diff({
      previousSchema: stored?.schema,
      databaseSchema: await db.dialect.schemaInspector.getSchema(),
      userSchema: db.schema.schema,
    });
    expect(status).toBe("CHANGED");
    const updated =
      diff.tables.updated.find((table) => table.name === "things")?.columns.updated ?? [];
    expect(updated.map((column) => column.name)).toEqual(["happened_at"]);
    const column = updated[0].object as unknown as SchemaColumn;
    expect(column).toMatchObject({
      type: "datetime",
      args: [{ useTz: false, precision: 6 }],
      notNullable: true,
    });

    // builder.js runs createColumn(...).alter() for every updated column
    // (on SQLite knex rebuilds the table to alter it) ...
    const statements: string[] = [];
    const listener = (event: KnexQueryEvent) => statements.push(event.sql);
    db.connection.on("query", listener);
    expect(await db.schema.sync()).toBe("CHANGED");
    db.connection.off("query", listener);
    expect(statements.some((sql) => /_knex_temp_alter/.test(sql))).toBe(true);

    // ... which on Postgres turns a timestamptz column back into timestamp(6).
    const pg = pgKnex();
    try {
      const ddl = pg.schema
        .alterTable("things", (table) => renderColumn(table, column).alter())
        .toString();
      expect(ddl).toContain(
        'alter column "happened_at" type timestamp(6) using ("happened_at"::timestamp(6))',
      );
      expect(ddl).not.toContain("timestamptz");
    } finally {
      await pg.destroy();
    }
  }, 30_000);

  it("runs pending user migrations BEFORE the schema diff of the same boot", async () => {
    engine = await openSqliteEngine([thingModel()], { schema: "sync" });
    const migrations = join(engine.dir, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "2026.09.28T00.00.00.probe-order.js"),
      [
        "module.exports = {",
        "  async up(knex) {",
        "    const seen = (await knex.schema.hasColumn('things', 'added_later')) ? 'present' : 'missing';",
        "    await knex.schema.createTable('probe_order', (table) => table.string('seen'));",
        "    await knex('probe_order').insert({ seen });",
        "  },",
        "};",
      ].join("\n"),
    );
    const db = await engine.reopen([thingModel({ addedLater: { type: "string" } })]);
    expect(await db.migrations.shouldRun()).toBe(true);
    expect(await db.schema.sync()).toBe("CHANGED");
    // The migration saw the table WITHOUT the new column; the sync added it after.
    expect(await db.connection.raw("select seen from probe_order")).toEqual([{ seen: "missing" }]);
    expect(await db.connection.schema.hasColumn("things", "added_later")).toBe(true);
  }, 30_000);
});

describe("@strapi/database query engine: a joined select adds DISTINCT without the id (the poll results bug)", () => {
  const POLL = "api::poll.poll";
  const VOTE = "api::poll-vote.poll-vote";
  const MODELS_WITH_JOIN = [
    {
      uid: POLL,
      singularName: "poll",
      tableName: "polls",
      attributes: { id: { type: "increments" } },
    },
    {
      uid: VOTE,
      singularName: "poll-vote",
      tableName: "poll_votes",
      attributes: {
        id: { type: "increments" },
        optionIndex: { type: "integer" },
        poll: { type: "relation", relation: "manyToOne", target: POLL },
      },
    },
  ];
  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it("collapses equal rows when the where joins a relation and the select leaves out the id", async () => {
    engine = await openSqliteEngine(MODELS_WITH_JOIN);
    const { db } = engine;
    await db.query(POLL).create({ data: {} });
    await db.query(POLL).create({ data: {} });
    for (const [optionIndex, poll] of [
      [0, 1],
      [0, 1],
      [1, 1],
      [0, 2],
    ]) {
      await db.query(VOTE).create({ data: { optionIndex, poll } });
    }

    const statements: string[] = [];
    const listener = (event: KnexQueryEvent) => statements.push(event.sql);
    db.connection.on("query", listener);
    const joined = await db
      .query(VOTE)
      .findMany({ select: ["optionIndex"], where: { poll: { id: 1 } } });
    db.connection.off("query", listener);
    expect(joined).toHaveLength(2);
    expect(statements.some((sql) => /select distinct/i.test(sql))).toBe(true);

    // With the id selected, or without a join, every vote is there.
    expect(
      await db.query(VOTE).findMany({ select: ["id", "optionIndex"], where: { poll: { id: 1 } } }),
    ).toHaveLength(3);
    expect(
      await db
        .query(VOTE)
        .findMany({ select: ["optionIndex"], where: { optionIndex: { $gte: 0 } } }),
    ).toHaveLength(4);
    expect(await db.query(VOTE).count({ where: { poll: { id: 1 } } })).toBe(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// @strapi/plugin-users-permissions
// ---------------------------------------------------------------------------

describe("users-permissions rateLimit: the throttle key (config/server.ts proxy trust, FX11)", () => {
  type BuildPrefixKey = (ctx: { request: { path: unknown; ip: string; body?: unknown } }) => string;
  const buildPrefixKey = () =>
    requirePackageFile<{ __require(): { buildPrefixKey: BuildPrefixKey } }>(
      upDir(),
      "dist/server/middlewares/rateLimit.js",
    ).__require().buildPrefixKey;

  it.each([
    [
      "/api/auth/local",
      { identifier: "ada", email: "x@y.z" },
      "noIdentifier:/api/auth/local:10.0.0.7",
    ],
    ["/API/Auth/Local/", { identifier: "ada" }, "noIdentifier:/api/auth/local:10.0.0.7"],
    [
      "/api/auth/reset-password",
      { email: "x@y.z" },
      "noIdentifier:/api/auth/reset-password:10.0.0.7",
    ],
    ["/api/auth/change-password", {}, "noIdentifier:/api/auth/change-password:10.0.0.7"],
    [
      "/api/connect/microsoft/callback",
      { email: "x@y.z" },
      "noIdentifier:/api/connect/microsoft/callback:10.0.0.7",
    ],
    [
      "/api/auth/forgot-password",
      { email: "Ada@Example.org" },
      "ada@example.org:/api/auth/forgot-password:10.0.0.7",
    ],
    ["/api/auth/forgot-password", {}, "unknownIdentifier:/api/auth/forgot-password:10.0.0.7"],
  ])("%s -> %s", (path, body, key) => {
    expect(buildPrefixKey()({ request: { path, ip: "10.0.0.7", body } })).toBe(key);
  });
});

describe("users-permissions 5.51+: no server-side provider access-token exchange", () => {
  it("refuses a provider callback without a completed grant session, whatever token the request carries", async () => {
    const store = {
      get: async ({ key }: { key: string }) =>
        key === "grant" ? { microsoft: { enabled: true } } : {},
    };
    const strapi = {
      store: () => store,
      config: { get: (_key: string, fallback?: unknown) => fallback },
    };
    vi.stubGlobal("strapi", strapi);
    const controller = requirePackageFile<{
      __require(): (deps: { strapi: unknown }) => { callback(ctx: unknown): Promise<unknown> };
    }>(upDir(), "dist/server/controllers/auth.js").__require()({ strapi });

    for (const ctx of [
      {
        params: { provider: "microsoft" },
        query: { access_token: "stolen" },
        request: { body: {} },
      },
      {
        params: { provider: "microsoft" },
        query: {},
        request: { body: { access_token: "stolen" } },
      },
      {
        params: { provider: "microsoft" },
        query: { code: "x" },
        request: { body: {} },
        session: {},
      },
    ]) {
      const attempt = controller.callback(ctx);
      await expect(attempt).rejects.toBeInstanceOf(errors.ApplicationError);
      await expect(attempt).rejects.toThrow(
        "OAuth authentication requires a completed provider session",
      );
    }
  });
});
