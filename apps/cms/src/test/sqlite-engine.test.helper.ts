/**
 * Test support: Strapi's real query engine (@strapi/database, the version the
 * cms runs with) on a throwaway SQLite file, plus the @strapi/core internals
 * the framework contract drives. Named *.test.helper.ts so the Strapi build
 * skips it and Vitest does not collect it.
 *
 * A temp FILE, not :memory:, because the engine's SQLite dialect resolves the
 * filename to a path (same as utils/poll-audience-backfill-sqlite.test.ts).
 * The entity manager reads the GLOBAL `strapi.db` (entity-manager/index.js
 * create), so openSqliteEngine stubs `strapi` with `{ db }`; callers that
 * need more on the global extend it with vi.stubGlobal and restore with
 * vi.unstubAllGlobals().
 *
 * Only the few calls the tests use are typed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";

/**
 * What knex emits per statement. (Its `__knexTxId` is no transaction marker
 * on SQLite: the single pooled connection keeps the id of its last
 * transaction, so look for BEGIN/SAVEPOINT statements instead.)
 */
export interface KnexQueryEvent {
  sql: string;
  bindings?: unknown[];
}

export interface EngineKnex {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
  on(event: "query", listener: (query: KnexQueryEvent) => void): unknown;
  off(event: "query", listener: (query: KnexQueryEvent) => void): unknown;
  schema: {
    hasTable(table: string): Promise<boolean>;
    hasColumn(table: string, column: string): Promise<boolean>;
  };
}

export interface EngineQuery {
  findOne(params?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findMany(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  count(params?: Record<string, unknown>): Promise<number>;
  create(params: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  delete(params: { where: Record<string, unknown> }): Promise<unknown>;
}

export interface SchemaDiffResult {
  status: "CHANGED" | "UNCHANGED";
  diff: {
    tables: {
      updated: Array<{
        name: string;
        columns: {
          updated: Array<{ name: string; object: Record<string, unknown> }>;
          added: unknown[];
        };
      }>;
    };
  };
}

export interface QueryEngine {
  connection: EngineKnex;
  metadata: { identifiers: unknown };
  init(options: { models: unknown[] }): Promise<unknown>;
  query(uid: string): EngineQuery;
  queryBuilder(uid: string): unknown;
  transaction<T>(callback: (scope: { trx: unknown }) => Promise<T>): Promise<T>;
  schema: {
    readonly schema: unknown;
    create(): Promise<void>;
    sync(): Promise<"CHANGED" | "UNCHANGED">;
    syncSchema(): Promise<"CHANGED" | "UNCHANGED">;
    schemaStorage: { read(): Promise<{ schema: unknown } | null> };
    schemaDiff: {
      diff(schemas: {
        previousSchema: unknown;
        databaseSchema: unknown;
        userSchema: unknown;
      }): Promise<SchemaDiffResult>;
    };
  };
  dialect: { schemaInspector: { getSchema(): Promise<unknown> } };
  migrations: { shouldRun(): Promise<boolean>; up(): Promise<void> };
  destroy(): Promise<void>;
}

type DatabaseConstructor = new (config: Record<string, unknown>) => QueryEngine;

const requireFromCms = createRequire(join(__dirname, "..", "..", "package.json"));
const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));

/** @strapi/database as @strapi/strapi resolves it (the version the cms runs). */
export function loadDatabase(): DatabaseConstructor {
  return (requireFromStrapi("@strapi/database") as { Database: DatabaseConstructor }).Database;
}

/** Directory of an installed @strapi/* package the cms runs with. */
export function strapiPackageDir(name: string): string {
  return dirname(requireFromStrapi.resolve(`${name}/package.json`));
}

/** A package the cms depends on directly (e.g. @strapi/plugin-users-permissions). */
export function cmsPackageDir(name: string): string {
  return dirname(requireFromCms.resolve(`${name}/package.json`));
}

/**
 * A file inside an installed package, loaded with Node's require by absolute
 * path: the packages' `exports` maps hide their dist internals, which the
 * framework contract pins on purpose.
 */
export function requirePackageFile<T>(packageDir: string, relativePath: string): T {
  return requireFromCms(join(packageDir, relativePath)) as T;
}

/** A module as an installed package resolves it (its own dependency tree). */
export function requireFromPackage<T>(packageDir: string, id: string): T {
  return createRequire(join(packageDir, "package.json"))(id) as T;
}

/** The version of an installed @strapi/* package. */
export function strapiPackageVersion(name: string): string {
  return requirePackageFile<{ version: string }>(strapiPackageDir(name), "package.json").version;
}

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export interface SqliteEngine {
  db: QueryEngine;
  /** The temp dir (user migrations go to `<dir>/migrations`). */
  dir: string;
  /** Closes the engine and opens a new one on the SAME file (a later boot with other models). */
  reopen(models: ModelSource): Promise<QueryEngine>;
  close(): Promise<void>;
}

function engineOn(file: string, migrationsDir: string): QueryEngine {
  const Database = loadDatabase();
  return new Database({
    connection: { client: "sqlite", connection: { filename: file }, useNullAsDefault: true },
    settings: { migrations: { dir: migrationsDir }, forceMigration: false },
    logger: quiet,
  });
}

/** Models, or a factory that builds them from the engine's identifiers (transformContentTypesToModels). */
export type ModelSource = unknown[] | ((identifiers: unknown) => unknown[]);

/**
 * A fresh SQLite database with `models` initialised. `create` builds the
 * schema directly; `sync` runs Strapi's own schema sync (migrations first).
 */
export async function openSqliteEngine(
  models: ModelSource,
  options: { schema?: "create" | "sync" | "none" } = {},
): Promise<SqliteEngine> {
  const dir = mkdtempSync(join(tmpdir(), "sinnlos-engine-"));
  const file = join(dir, "cms.db");
  const migrationsDir = join(dir, "migrations");
  const engines: QueryEngine[] = [];
  const closeEngines = async () => {
    for (const engine of engines.splice(0)) await engine.destroy();
  };
  const open = async (source: ModelSource) => {
    await closeEngines();
    const db = engineOn(file, migrationsDir);
    engines.push(db);
    await db.init({
      models: typeof source === "function" ? source(db.metadata.identifiers) : source,
    });
    vi.stubGlobal("strapi", { db });
    return db;
  };
  const db = await open(models);
  if ((options.schema ?? "create") === "create") await db.schema.create();
  if (options.schema === "sync") await db.schema.sync();
  return {
    db,
    dir,
    reopen: open,
    async close() {
      await closeEngines();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
