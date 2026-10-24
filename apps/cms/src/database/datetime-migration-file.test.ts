import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LEGACY_MIGRATION_NAME, refuseLegacyDatetimeData } from "./datetime-catalog";

/**
 * The user migration is plain CommonJS in <app root>/database/migrations,
 * where @strapi/database discovers it (Strapi.js passes `database/migrations`
 * under the app root; migrations/discover.js keeps *.js and *.sql, sorted by
 * name). It loads the compiled check from strapi.dirs.dist.src at run time.
 * This pins the file name (the name the guard's interlock looks for in
 * strapi_migrations) and that wiring; datetime-migration-file.pg.test.ts runs
 * the check against Postgres 16.
 */
const MIGRATIONS_DIR = join(__dirname, "..", "..", "database", "migrations");
const MIGRATION_FILE = join(MIGRATIONS_DIR, LEGACY_MIGRATION_NAME);

type Migration = { up(trx: unknown, db: unknown): Promise<void>; down(): Promise<void> };

describe("datetime user migration file", () => {
  const scope = globalThis as unknown as { strapi?: unknown; __checkCalls?: unknown[][] };
  const previousStrapi = scope.strapi;
  let distSrc = "";

  afterEach(() => {
    scope.strapi = previousStrapi;
    delete scope.__checkCalls;
    if (distSrc) rmSync(distSrc, { recursive: true, force: true });
  });

  it("is the only migration Strapi will discover, under the name the guard expects", () => {
    expect(existsSync(MIGRATION_FILE)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((name) => /\.(js|sql)$/.test(name))).toEqual([
      LEGACY_MIGRATION_NAME,
    ]);
  });

  it("hands Strapi's (trx, db) and logger to the compiled check in dist; down changes nothing", async () => {
    distSrc = mkdtempSync(join(tmpdir(), "sinnlos-dist-"));
    mkdirSync(join(distSrc, "database"));
    writeFileSync(
      join(distSrc, "database", "datetime-catalog.js"),
      "exports.refuseLegacyDatetimeData = async (...args) => { globalThis.__checkCalls.push(args); };\n",
    );
    scope.__checkCalls = [];
    const log = { info: () => undefined, warn: () => undefined };
    scope.strapi = { dirs: { dist: { src: distSrc } }, log };

    const migration = createRequire(__filename)(MIGRATION_FILE) as Migration;
    const trx = { raw: () => undefined };
    const db = { dialect: { client: "postgres" } };
    await migration.up(trx, db);

    expect(scope.__checkCalls).toEqual([[trx, db, log]]);
    await expect(migration.down()).resolves.toBeUndefined();
  });

  it("does nothing on SQLite (epoch ms, no naive columns)", async () => {
    const trx = { raw: vi.fn() };
    await refuseLegacyDatetimeData(trx, { dialect: { client: "sqlite" }, getSchemaName: () => "" });
    expect(trx.raw).not.toHaveBeenCalled();
  });
});
