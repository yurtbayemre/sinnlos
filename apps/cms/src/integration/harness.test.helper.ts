/**
 * Strapi-in-process integration harness (roadmap S11).
 *
 * Boots the REAL cms in the test process: the build compiled once per run by
 * global-setup.test.helper.ts, `createStrapi` from @strapi/strapi (no admin
 * panel), the real register()/bootstrap() of src/index.ts with every policy,
 * middleware, sanitizer, lifecycle and permission sync, and a listening HTTP
 * server on an ephemeral 127.0.0.1 port. Suites talk to it over HTTP with
 * JWTs from POST /api/auth/local, and reach into it through `strapi` for
 * fixtures (Document Service) and direct row checks.
 *
 *   const t = await createTestStrapi({ engine: "sqlite", env: { SEED_DEMO_DATA: "1" } });
 *   const res = await t.api<{ data: unknown[] }>("member", "/api/polls");
 *   await t.stop();
 *
 * Run it with `pnpm test:integration` (vitest.integration.config.ts); the
 * unit run (`pnpm test`) excludes *.integration.test.ts.
 *
 * DATABASES — `testEngines()` is ["sqlite"] plus "postgres" when
 * SINNLOS_TEST_PG_URL is set (the `*.pg.test.ts` convention):
 *   - sqlite: a fresh file under the build's temp root, deleted by stop();
 *   - postgres: a fresh schema (DATABASE_SCHEMA) on that server, dropped by
 *     stop(). A fresh schema is a first boot, which the datetime contract
 *     allows only in a UTC process: vitest.integration.config.ts pins TZ=UTC.
 * Every boot starts empty. `createTestDatabase` + `database:` boot twice on
 * one database (a restart; the caller drops it), and `database.sql()` reads
 * or writes it while no Strapi runs.
 *
 * FIXTURES (unless `fixtures: false`): departments "IT Engineering" and
 * "IT Sales", team "IT Platform" (Engineering), and one user per role in
 * TEST_ROLES (username `it-<role>` with dashes, e.g. `it-admin-role`,
 * display name `Fixture <role>`, a random password per boot, a phone and an
 * office for the contact-field checks):
 *   - admin_role, editor, member: Engineering;
 *   - department_head: Engineering, and its head;
 *   - team_lead: Engineering, lead and member of IT Platform (member is
 *     a team member too);
 *   - guest and authenticated (the users-permissions fallback role): no
 *     department.
 * Departments/teams go through the Document Service, users through the
 * users-permissions user service (as the demo seed writes them). Suites add
 * their own content through `strapi.documents(uid)`.
 * `env: { SEED_DEMO_DATA: "1" }` also runs the demo seed of the real
 * bootstrap. It runs inside bootstrap, before the fixtures exist, so both
 * coexist; the demo accounts sign in with `login(username, "demo1234")`.
 *
 * HERMETIC:
 *   - the env of a boot is a fixed base (random secrets, no SMTP, no
 *     WEB_INTERNAL_URL, no Microsoft: every MS_* and ENTRA_* key and
 *     AUTH_LOCAL_ENABLED unset, so Entra is off and local sign-in on; no
 *     STRAPI_ADMIN_*, telemetry off) plus `env`; stop() restores
 *     process.env;
 *   - no dotenv file refills that base: @strapi/core loads dotenv from
 *     ENV_PATH (default `<cwd>/.env`) once per process, at the first
 *     Strapi require, which boot() does after setting the env; ENV_PATH
 *     points at a file that does not exist then;
 *   - `fetch` to anything but loopback is refused while a Strapi runs, and
 *     stop() fails when the cms tried one. `outbound` serves such requests
 *     from the test instead (a stubbed IdP or Graph for the Entra
 *     provisioning suite, batch 4). Only `fetch` is guarded, not
 *     http/https/net; the base env leaves SMTP, WEB_INTERNAL_URL and
 *     Microsoft unset;
 *   - the crons are off (`server.cron.enabled`), so no 03:30 janitor or
 *     07:30 digest fires mid-run;
 *   - temp files and schemas are removed by stop() and the global teardown.
 *
 * TEST-ONLY DEVIATIONS from production, all set here and nowhere else:
 *   - the users-permissions login throttle (10 per minute and IP; every test
 *     login comes from 127.0.0.1) is off; framework-contract.test.ts pins
 *     its key;
 *   - crons off (above); the Strapi logger runs at `error` (set
 *     SINNLOS_IT_LOG_LEVEL=info to see the boot).
 *
 * FOR LATER SUITES: the Entra provisioning suite (batch 4) passes its env
 * (`env`, e.g. ENTRA_ENABLED and the tenant), serves JWKS and Graph
 * through `outbound` (a non-loopback fetch of the cms reaches the handler
 * as a Request), signs in through `api(null, "/api/auth/entra/exchange",
 * { json })`, and reads the provisioned rows through `strapi.db.query`.
 * The password-change revocation suite (FX40) takes
 * `fixtures.users[role].password`, keeps the old JWT from `loginAs(role)`,
 * changes the password over `api(role, "/api/auth/change-password",
 * { json })` and expects 401 for `api({ jwt: old }, ...)`. Module state of
 * the running cms (e.g. the notification fan-out queue) is reachable with
 * `requireBuilt("src/utils/<module>")`.
 *
 * Process hygiene: `strapi.destroy()` calls `process.removeAllListeners()`,
 * which would cut the vitest worker's own IPC and error handlers; stop()
 * puts back the listeners that existed before the boot. A failed boot is
 * cleaned up the same way and rethrows its error (never `process.exit`,
 * which `strapi.start()` would do).
 *
 * Named *.test.helper.ts: not part of the Strapi build, not collected as a
 * suite.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { inject } from "vitest";

import { PG_URL, uniqueSchema } from "../database/pg-test-db.test.helper";
import { loadStrapiKnex } from "../database/strapi-knex.test.helper";
import { CMS_APP_DIR } from "./global-setup.test.helper";

// ---------------------------------------------------------------------------
// Types: only the slice of Strapi the suites use.

/** A row as the Document Service and the query engine return it. */
export interface Row {
  id: number;
  documentId: string;
  [field: string]: unknown;
}

export type Params = Record<string, unknown>;

export interface DocumentApi {
  create(params: { data: Params; status?: "draft" | "published" }): Promise<Row>;
  update(params: {
    documentId: string;
    data: Params;
    status?: "draft" | "published";
  }): Promise<Row>;
  publish(params: { documentId: string }): Promise<{ documentId: string; entries: Row[] }>;
  unpublish(params: { documentId: string }): Promise<unknown>;
  findOne(params: {
    documentId: string;
    status?: "draft" | "published";
    populate?: unknown;
  }): Promise<Row | null>;
  findMany(params?: Params): Promise<Row[]>;
  delete(params: { documentId: string }): Promise<unknown>;
}

export interface DbQuery {
  findOne(params?: Params): Promise<Row | null>;
  findMany(params?: Params): Promise<Row[]>;
  count(params?: Params): Promise<number>;
  create(params: { data: Params }): Promise<Row>;
  update(params: { where: Params; data: Params }): Promise<Row | null>;
  delete(params: { where: Params }): Promise<unknown>;
}

/** What a `strapi.db.transaction` callback receives. */
export interface TransactionScope {
  onCommit(callback: () => unknown): void;
  onRollback(callback: () => unknown): void;
}

interface Logger {
  level: string;
}

/** The Strapi instance, typed as far as the suites and the harness use it. */
export interface IntegrationStrapi {
  /** The loaded content-type schemas by uid. */
  contentTypes: Record<
    string,
    { collectionName?: string; options?: { draftAndPublish?: boolean } }
  >;
  documents(uid: string): DocumentApi;
  db: {
    query(uid: string): DbQuery;
    transaction<T>(callback: (scope: TransactionScope) => Promise<T>): Promise<T>;
  };
  plugin(name: string): { service(name: string): unknown };
  config: {
    get(path: string, fallback?: unknown): unknown;
    set(path: string, value: unknown): void;
  };
  log: Logger;
  load(): Promise<unknown>;
  destroy(): Promise<void>;
  server: {
    listen(port: number, host: string, callback: () => void): unknown;
    httpServer: { address(): AddressInfo | string | null };
  };
}

interface UsersPermissionsUserService {
  add(values: Params): Promise<Row>;
}

type CreateStrapi = (options: {
  appDir: string;
  distDir: string;
  autoReload: boolean;
  serveAdminPanel: boolean;
}) => unknown;

// ---------------------------------------------------------------------------
// Engines and databases.

export type TestEngine = "sqlite" | "postgres";

/** sqlite always; postgres when SINNLOS_TEST_PG_URL is set. */
export function testEngines(): TestEngine[] {
  return PG_URL ? ["sqlite", "postgres"] : ["sqlite"];
}

/** An empty database for one or more boots. */
export interface TestDatabase {
  readonly engine: TestEngine;
  /** The DATABASE_* env config/database.ts reads. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Raw SQL on this database, outside any Strapi (e.g. between two boots);
   * unqualified table names resolve in the test schema. Returns the rows
   * of a SELECT, [] otherwise.
   */
  sql<T = Record<string, unknown>>(statement: string, bindings?: readonly unknown[]): Promise<T[]>;
  /** Removes the SQLite file or drops the Postgres schema. Idempotent. */
  drop(): Promise<void>;
}

/** Rows out of a knex raw() result: an array (SQLite) or `{ rows }` (pg). */
function rawRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** The build root provided by the global setup. */
function buildRoot(): string {
  const root = inject("sinnlosCmsBuild");
  if (typeof root !== "string" || root === "") {
    throw new Error(
      "[integration] no compiled cms: run the suites with `pnpm test:integration` " +
        "(vitest.integration.config.ts compiles the cms in its global setup)",
    );
  }
  return root;
}

const uniqueName = (prefix: string) => `${prefix}_${process.pid}_${randomBytes(4).toString("hex")}`;

export async function createTestDatabase(engine: TestEngine): Promise<TestDatabase> {
  if (engine === "sqlite") {
    // config/database.ts: join(dist/config, "..", "..", DATABASE_FILENAME)
    // = <build root>/<DATABASE_FILENAME>. Relative on purpose, so it also
    // holds for a path.resolve there.
    const relative = `db/${uniqueName("cms")}.db`;
    const file = join(buildRoot(), relative);
    let dropped = false;
    return {
      engine,
      env: { DATABASE_CLIENT: "sqlite", DATABASE_FILENAME: relative },
      async sql<T>(statement: string, bindings: readonly unknown[] = []) {
        const knex = loadStrapiKnex()({
          client: "better-sqlite3",
          connection: { filename: file },
          useNullAsDefault: true,
        });
        try {
          return rawRows<T>(await knex.raw(statement, bindings));
        } finally {
          await knex.destroy();
        }
      },
      async drop() {
        if (dropped) return;
        dropped = true;
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
          rmSync(`${file}${suffix}`, { force: true });
        }
      },
    };
  }
  if (!PG_URL) throw new Error("[integration] postgres needs SINNLOS_TEST_PG_URL");
  const schema = uniqueSchema("sinnlos_it");
  // One connection, UTC session like config/database.ts, the test schema first.
  const knex = loadStrapiKnex()({
    client: "pg",
    connection: { connectionString: PG_URL, options: "-c TimeZone=UTC" },
    searchPath: [schema],
    pool: { min: 0, max: 1 },
  });
  try {
    await knex.raw(`CREATE SCHEMA "${schema}"`);
  } catch (err) {
    await knex.destroy();
    throw err;
  }
  let dropped = false;
  return {
    engine,
    env: {
      DATABASE_CLIENT: "postgres",
      DATABASE_URL: PG_URL,
      DATABASE_SCHEMA: schema,
      DATABASE_POOL_MIN: "0",
      DATABASE_POOL_MAX: "5",
    },
    async sql<T>(statement: string, bindings: readonly unknown[] = []) {
      return rawRows<T>(await knex.raw(statement, bindings));
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      try {
        await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await knex.destroy();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Roles, fixtures, HTTP.

/** The six intranet roles plus the users-permissions fallback role. */
export const TEST_ROLES = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "guest",
  "authenticated",
] as const;

export type TestRole = (typeof TEST_ROLES)[number];

export interface TestUser {
  id: number;
  documentId: string;
  username: string;
  email: string;
  displayName: string;
  password: string;
}

export interface TestFixtures {
  departments: { engineering: Row; sales: Row };
  teams: { platform: Row };
  users: Record<TestRole, TestUser>;
}

/** Who calls: a fixture role, an explicit JWT, or nobody (public). */
export type Caller = TestRole | { jwt: string } | null;

export interface ApiInit {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body (sets content-type; the method defaults to POST). */
  json?: unknown;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: T;
  text: string;
}

/** Serves a non-loopback request from the test, or refuses it (undefined). */
export type OutboundHandler = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>;

export interface TestStrapiOptions {
  engine?: TestEngine;
  /** Extra env for this boot, over the hermetic base (undefined deletes). */
  env?: Record<string, string | undefined>;
  /** Org + one user per role (default true). Requires the fixtures' roles. */
  fixtures?: boolean;
  /** Boot on this database instead of a fresh one (the caller drops it). */
  database?: TestDatabase;
  outbound?: OutboundHandler;
}

export interface TestStrapi {
  readonly strapi: IntegrationStrapi;
  readonly engine: TestEngine;
  readonly database: TestDatabase;
  /** http://127.0.0.1:<port> */
  readonly baseUrl: string;
  /** Present unless booted with `fixtures: false`. */
  readonly fixtures: TestFixtures;
  /** JWT of the fixture user of `role` (cached per boot). */
  loginAs(role: TestRole): Promise<string>;
  /** JWT for any account (POST /api/auth/local). */
  login(identifier: string, password: string): Promise<string>;
  api<T = unknown>(caller: Caller, path: string, init?: ApiInit): Promise<ApiResponse<T>>;
  /** A compiled cms module from the running build (shares its module state). */
  requireBuilt<T>(path: string): T;
  /** Destroys Strapi, restores env and listeners, drops an owned database. */
  stop(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hermeticEnv(): Record<string, string | undefined> {
  const secret = () => randomBytes(24).toString("base64url");
  return {
    // Secrets: random per boot, never a template value (env-guard).
    APP_KEYS: `${secret()},${secret()}`,
    API_TOKEN_SALT: secret(),
    ADMIN_JWT_SECRET: secret(),
    TRANSFER_TOKEN_SALT: secret(),
    JWT_SECRET: secret(),
    ENCRYPTION_KEY: secret(),
    HOST: "127.0.0.1",
    PORT: "0",
    PUBLIC_URL: "http://127.0.0.1",
    APP_TIME_ZONE: "Europe/Berlin",
    STRAPI_TELEMETRY_DISABLED: "true",
    // Off unless a suite asks for them.
    SEED_DEMO_DATA: undefined,
    LOCAL_REGISTRATION: undefined,
    WEB_INTERNAL_URL: undefined,
    REVALIDATE_SECRET: undefined,
    LIVE_EVENTS_DISABLED: undefined,
    INTERNAL_UPLOAD_TOKEN: undefined,
    CORS_ORIGIN: undefined,
    PUBLIC_WEB_URL: undefined,
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    DIGEST_FROM: undefined,
    DIGEST_REPLY_TO: undefined,
    DIGESTS_DISABLED: undefined,
    MS_CLIENT_ID: undefined,
    MS_CLIENT_SECRET: undefined,
    MS_TENANT_ID: undefined,
    AUTH_MICROSOFT_ENTRA_ID_ID: undefined,
    AUTH_MICROSOFT_ENTRA_ID_SECRET: undefined,
    // The Entra sign-in (entra/config.ts parseEntraConfig reads each one): a
    // shell with ENTRA_ENABLED=1 would otherwise refuse every boot (or run
    // an Entra-only cms). The provisioning suite passes its own values.
    ENTRA_ENABLED: undefined,
    ENTRA_EXCHANGE_SECRET: undefined,
    ENTRA_SYNC_MODE: undefined,
    ENTRA_DEFAULT_ROLE: undefined,
    ENTRA_GROUP_ROLES: undefined,
    ENTRA_SYNC_DEPARTMENT: undefined,
    ENTRA_SYNC_MANAGER: undefined,
    ENTRA_SESSION_TTL: undefined,
    AUTH_LOCAL_ENABLED: undefined,
    STRAPI_ADMIN_EMAIL: undefined,
    STRAPI_ADMIN_PASSWORD: undefined,
    STRAPI_ADMIN_FIRSTNAME: undefined,
    STRAPI_ADMIN_LASTNAME: undefined,
    DATABASE_CLIENT: undefined,
    DATABASE_URL: undefined,
    DATABASE_FILENAME: undefined,
    DATABASE_SCHEMA: undefined,
    DATABASE_HOST: undefined,
    DATABASE_PORT: undefined,
    DATABASE_NAME: undefined,
    DATABASE_USERNAME: undefined,
    DATABASE_PASSWORD: undefined,
    DATABASE_SSL: undefined,
    DATABASE_POOL_MIN: undefined,
    DATABASE_POOL_MAX: undefined,
    DATABASE_FORCE_MIGRATION: undefined,
  };
}

/** Applies `env` to process.env; the returned function restores it. */
function applyEnv(env: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

type ListenerSnapshot = Map<string | symbol, ((...args: unknown[]) => void)[]>;

function snapshotProcessListeners(): ListenerSnapshot {
  const snapshot: ListenerSnapshot = new Map();
  for (const event of process.eventNames()) {
    snapshot.set(event, process.rawListeners(event) as ((...args: unknown[]) => void)[]);
  }
  return snapshot;
}

/** Puts back the listeners of `snapshot` that are gone now. */
function restoreProcessListeners(snapshot: ListenerSnapshot): void {
  const target = process as unknown as {
    rawListeners(event: string | symbol): unknown[];
    on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  };
  for (const [event, listeners] of snapshot) {
    const present = new Set(target.rawListeners(event));
    for (const listener of listeners) {
      if (!present.has(listener)) target.on(event, listener);
    }
  }
}

/**
 * Replaces global fetch while a Strapi runs: loopback passes, anything else
 * goes to `outbound` or is refused and recorded. Returns the uninstaller and
 * the record.
 */
function guardNetwork(realFetch: typeof fetch, outbound: OutboundHandler | undefined) {
  const refused: string[] = [];
  const guarded = async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (LOOPBACK_HOSTS.has(url.hostname)) return realFetch(input, init);
    const served = outbound ? await outbound(request) : undefined;
    if (served) return served;
    refused.push(`${request.method} ${url.origin}${url.pathname}`);
    throw new TypeError(`[integration] outbound request refused: ${request.method} ${url.origin}`);
  };
  globalThis.fetch = guarded as typeof fetch;
  return {
    refused,
    uninstall() {
      if (globalThis.fetch === (guarded as typeof fetch)) globalThis.fetch = realFetch;
    },
  };
}

async function readResponse<T>(res: Response): Promise<ApiResponse<T>> {
  const text = await res.text();
  let body: unknown = text;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: keep the text.
    }
  } else {
    body = null;
  }
  return { status: res.status, headers: res.headers, body: body as T, text };
}

async function createFixtures(strapi: IntegrationStrapi): Promise<TestFixtures> {
  const departments = strapi.documents("api::department.department");
  const engineering = await departments.create({
    data: { name: "IT Engineering", slug: "it-engineering" },
  });
  const sales = await departments.create({ data: { name: "IT Sales", slug: "it-sales" } });

  const roles = strapi.db.query("plugin::users-permissions.role");
  const userService = strapi
    .plugin("users-permissions")
    .service("user") as UsersPermissionsUserService;
  const users = {} as Record<TestRole, TestUser>;
  for (const role of TEST_ROLES) {
    const roleRow = await roles.findOne({ where: { type: role } });
    if (!roleRow) throw new Error(`[integration] role ${role} missing after bootstrap`);
    const username = `it-${role.replace(/_/g, "-")}`;
    const password = randomBytes(12).toString("base64url");
    const staff = role !== "guest" && role !== "authenticated";
    const user = await userService.add({
      username,
      email: `${username}@integration.test`,
      displayName: `Fixture ${role}`,
      provider: "local",
      password,
      confirmed: true,
      blocked: false,
      role: roleRow.id,
      department: staff ? engineering.id : null,
      phone: `+49 30 0000 ${TEST_ROLES.indexOf(role)}`,
      officeLocation: "Integration Lab",
    });
    users[role] = {
      id: user.id,
      documentId: user.documentId,
      username,
      email: `${username}@integration.test`,
      displayName: `Fixture ${role}`,
      password,
    };
  }

  const engineeringWithHead = await departments.update({
    documentId: engineering.documentId,
    data: { head: users.department_head.documentId },
  });
  const platform = await strapi.documents("api::team.team").create({
    data: {
      name: "IT Platform",
      slug: "it-platform",
      department: engineering.documentId,
      lead: users.team_lead.documentId,
      members: [users.team_lead.documentId, users.member.documentId],
    },
  });
  return { departments: { engineering: engineeringWithHead, sales }, teams: { platform }, users };
}

/** Strapi is a process singleton (the `strapi` global): one boot at a time per worker. */
let running = false;

/**
 * Boots the cms (see the file header). Resolves once it listens and the
 * fixtures exist; a failed boot is cleaned up and rethrows the boot error.
 */
export async function createTestStrapi(options: TestStrapiOptions = {}): Promise<TestStrapi> {
  if (running)
    throw new Error("[integration] a Strapi is already running in this process: stop() it first");
  running = true;
  try {
    return await boot(options);
  } catch (err) {
    running = false;
    throw err;
  }
}

async function boot(options: TestStrapiOptions): Promise<TestStrapi> {
  const root = buildRoot();
  const engine = options.database?.engine ?? options.engine ?? "sqlite";
  const database = options.database ?? (await createTestDatabase(engine));
  const ownsDatabase = options.database === undefined;

  // @strapi/core's configuration module calls dotenv.config({ path:
  // process.env.ENV_PATH }) once, at load: on the first boot of this fork,
  // in the require below. A shell ENV_PATH or a <cwd>/.env would refill the
  // keys the base deletes (dotenv sets only unset keys), so ENV_PATH points
  // at a file that does not exist (dotenv skips it silently).
  const restoreEnv = applyEnv({
    ...hermeticEnv(),
    ENV_PATH: join(root, "no-such.env"),
    ...database.env,
    ...options.env,
  });
  const realFetch = globalThis.fetch;
  const network = guardNetwork(realFetch, options.outbound);
  const listeners = snapshotProcessListeners();

  const requireFromCms = createRequire(join(CMS_APP_DIR, "package.json"));
  const { createStrapi } = requireFromCms("@strapi/strapi") as { createStrapi: CreateStrapi };
  const requireFromBuild = createRequire(join(root, "dist", "package.json"));

  let strapi: IntegrationStrapi | undefined;
  const release = async () => {
    try {
      if (strapi) await strapi.destroy();
    } finally {
      restoreProcessListeners(listeners);
      network.uninstall();
      restoreEnv();
      if (ownsDatabase) await database.drop();
    }
  };

  try {
    strapi = createStrapi({
      appDir: root,
      distDir: join(root, "dist"),
      autoReload: false,
      serveAdminPanel: false,
    }) as IntegrationStrapi;
    strapi.log.level = process.env.SINNLOS_IT_LOG_LEVEL ?? "error";
    strapi.config.set("server.cron.enabled", false);
    await strapi.load();
    // Plugin config is (re)built during load(); the throttle reads it per request.
    strapi.config.set("plugin::users-permissions.ratelimit", { enabled: false });
  } catch (err) {
    await release().catch(() => undefined);
    throw err;
  }

  const booted = strapi;
  let fixtures: TestFixtures | undefined;
  let baseUrl: string;
  try {
    if (options.fixtures !== false) fixtures = await createFixtures(booted);
    await new Promise<void>((resolve) => booted.server.listen(0, "127.0.0.1", resolve));
    const address = booted.server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("[integration] no TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  } catch (err) {
    await release().catch(() => undefined);
    throw err;
  }

  const jwts = new Map<TestRole, string>();
  const login = async (identifier: string, password: string): Promise<string> => {
    const res = await realFetch(`${baseUrl}/api/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    const { status, body, text } = await readResponse<{ jwt?: unknown }>(res);
    if (status !== 200 || typeof body?.jwt !== "string") {
      throw new Error(`[integration] login of ${identifier} failed: ${status} ${text}`);
    }
    return body.jwt;
  };
  const loginAs = async (role: TestRole): Promise<string> => {
    const cached = jwts.get(role);
    if (cached) return cached;
    if (!fixtures) throw new Error("[integration] loginAs needs the fixtures (fixtures: false)");
    const user = fixtures.users[role];
    const jwt = await login(user.username, user.password);
    jwts.set(role, jwt);
    return jwt;
  };

  let stopped = false;
  return {
    strapi: booted,
    engine,
    database,
    baseUrl,
    get fixtures(): TestFixtures {
      if (!fixtures) throw new Error("[integration] booted with fixtures: false");
      return fixtures;
    },
    loginAs,
    login,
    async api<T = unknown>(
      caller: Caller,
      path: string,
      init: ApiInit = {},
    ): Promise<ApiResponse<T>> {
      const headers = new Headers(init.headers);
      if (caller !== null) {
        const jwt = typeof caller === "string" ? await loginAs(caller) : caller.jwt;
        headers.set("authorization", `Bearer ${jwt}`);
      }
      let body: string | undefined;
      if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
      }
      const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
      return readResponse<T>(await realFetch(`${baseUrl}${path}`, { method, headers, body }));
    },
    requireBuilt<T>(path: string): T {
      return requireFromBuild(`./${path}`) as T;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await release();
      } finally {
        running = false;
      }
      if (network.refused.length > 0) {
        throw new Error(
          `[integration] the cms tried to reach the network: ${network.refused.join(", ")}`,
        );
      }
    },
  };
}
