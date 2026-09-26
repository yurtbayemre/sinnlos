import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LEGACY_MIGRATION_NAME } from "./datetime-catalog";

/**
 * The user migration is plain CommonJS in <app root>/database/migrations,
 * where @strapi/database 5.55.1 discovers it (Strapi.js:228-238 passes
 * `database/migrations` under the app root; migrations/discover.js keeps
 * *.js and *.sql, sorted by name). It loads the compiled repair from
 * strapi.dirs.dist.src at run time. This pins the file name (the name the
 * guard's interlock looks for in strapi_migrations) and that wiring.
 */
const MIGRATIONS_DIR = join(__dirname, "..", "..", "database", "migrations");
const MIGRATION_FILE = join(MIGRATIONS_DIR, LEGACY_MIGRATION_NAME);

type Migration = { up(trx: unknown, db: unknown): Promise<void>; down(): Promise<void> };

describe("datetime user migration file", () => {
  const scope = globalThis as unknown as { strapi?: unknown; __repairCalls?: unknown[][] };
  const previousStrapi = scope.strapi;
  let distSrc = "";

  afterEach(() => {
    scope.strapi = previousStrapi;
    delete scope.__repairCalls;
    if (distSrc) rmSync(distSrc, { recursive: true, force: true });
  });

  it("is the only migration Strapi will discover, under the name the guard expects", () => {
    expect(existsSync(MIGRATION_FILE)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((name) => /\.(js|sql)$/.test(name))).toEqual([LEGACY_MIGRATION_NAME]);
  });

  it("hands Strapi's (trx, db) to the compiled repair in dist, with the env and Strapi's logger", async () => {
    distSrc = mkdtempSync(join(tmpdir(), "sinnlos-dist-"));
    mkdirSync(join(distSrc, "database"));
    writeFileSync(
      join(distSrc, "database", "datetime-legacy.js"),
      "exports.runLegacyDatetimeMigration = async (...args) => { globalThis.__repairCalls.push(args); };\n",
    );
    scope.__repairCalls = [];
    const log = { info: () => undefined, warn: () => undefined };
    scope.strapi = { dirs: { dist: { src: distSrc } }, log };

    const migration = createRequire(__filename)(MIGRATION_FILE) as Migration;
    const trx = { raw: () => undefined };
    const db = { dialect: { client: "postgres" } };
    await migration.up(trx, db);

    expect(scope.__repairCalls).toHaveLength(1);
    const [calledTrx, calledDb, options] = scope.__repairCalls[0] as [unknown, unknown, { env: unknown; log: unknown }];
    expect(calledTrx).toBe(trx);
    expect(calledDb).toBe(db);
    expect(options.env).toBe(process.env);
    expect(options.log).toBe(log);
    await expect(migration.down()).rejects.toThrow(/restore the pre-deploy database dump/);
  });
});
