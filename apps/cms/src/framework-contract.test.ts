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
import { getMutableQuery, restrictiveIdFilter } from "./utils/policy-query";

/**
 * Framework contract (roadmap S04): the Strapi behaviour this cms is built
 * on, pinned against the INSTALLED packages (@strapi/utils, @strapi/core,
 * @strapi/database, @strapi/plugin-users-permissions 5.55.1). Each block
 * names the code that relies on it. The utils and core traps run the real
 * modules; the database traps run @strapi/database on a throwaway SQLite
 * file (src/test/sqlite-engine.test.helper.ts), like
 * utils/poll-audience-backfill-sqlite.test.ts.
 *
 * RUN THIS BEFORE EVERY @strapi/* BUMP. The version pin below fails first on
 * purpose: bump it only after every other block here passes against the new
 * packages, or after the code that relies on a changed behaviour (and its
 * comment) is updated. A block that fails means an assumption of this cms no
 * longer holds, not that the test is wrong.
 */

const STRAPI_VERSION = "5.55.1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const coreDir = () => strapiPackageDir("@strapi/core");
const upDir = () => cmsPackageDir("@strapi/plugin-users-permissions");

describe("installed versions (bump only after this whole file passes)", () => {
  it.each(["@strapi/core", "@strapi/utils", "@strapi/database", "@strapi/strapi"])("%s", (name) => {
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

  it("passes the same filter with the find scope, and never checks populate (5.55.1)", async () => {
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

describe("@strapi/core strapi::public registers routes, mounted after every global middleware (uploads-auth)", () => {
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
  });

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
  }

  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  async function documents(): Promise<{ docs: Documents; db: QueryEngine }> {
    const { transformContentTypesToModels } = requirePackageFile<{
      transformContentTypesToModels(contentTypes: unknown[], identifiers: unknown): unknown[];
    }>(coreDir(), "dist/utils/transform-content-types-to-models.js");
    engine = await openSqliteEngine((identifiers) =>
      transformContentTypesToModels([NOTE_TYPE], identifiers),
    );
    const { db } = engine;
    const contentTypes: Record<string, unknown> = { [NOTE]: NOTE_TYPE };
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
      // i18n is always installed; this type is not localized.
      plugin: (name: string) =>
        name === "i18n"
          ? {
              service: (service: string) =>
                service === "content-types"
                  ? { isLocalizedContentType: () => false }
                  : { getDefaultLocale: async () => "en" },
            }
          : undefined,
    };
    const queryParams = requirePackageFile<(strapi: unknown) => unknown>(
      coreDir(),
      "dist/services/query-params.js",
    )(fake);
    fake.get = (name: string) => {
      if (name === "query-params") return queryParams;
      throw new Error(`strapi.get(${name}) not stubbed`);
    };
    vi.stubGlobal("strapi", fake);
    const { createDocumentService } = requirePackageFile<{
      createDocumentService(strapi: unknown): (uid: string) => Documents;
    }>(coreDir(), "dist/services/document-service/index.js");
    return { docs: createDocumentService(fake)(NOTE), db };
  }

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
  });

  it("a status taken from the client params reads the draft rows", async () => {
    const { docs } = await documents();
    const created = await docs.create({ data: { title: "Draft only" } });
    expect(await docs.findMany({ status: "published" })).toEqual([]);
    expect((await docs.findMany({ status: "draft" })).map((row) => row.id)).toEqual([created.id]);
  });

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
  });
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
  });

  it("re-syncs an unchanged model without touching the column", async () => {
    engine = await openSqliteEngine([thingModel()], { schema: "sync" });
    const db = await engine.reopen([thingModel()]);
    expect(await db.schema.sync()).toBe("UNCHANGED");
  });

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
  });

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
  });
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
  });
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
