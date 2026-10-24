import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_DATETIME_MESSAGE,
  LEGACY_MIGRATION_NAME,
  refuseLegacyDatetimeData,
  type MigrationDb,
} from "./datetime-catalog";
import { PG_URL, createTestKnex, rows, uniqueSchema } from "./pg-test-db.test.helper";
import { type RawKnex } from "./strapi-knex.test.helper";

/**
 * The datetime user migration's check (refuseLegacyDatetimeData) against a
 * real Postgres 16 (runs only with SINNLOS_TEST_PG_URL set): a fresh schema
 * and empty naive columns pass, pre-contract data is refused.
 */
describe.skipIf(!PG_URL)("datetime user migration on Postgres 16", () => {
  let knex: RawKnex;
  let schema: string;
  const db = () => ({ dialect: { client: "postgres" }, getSchemaName: () => schema });
  const log = () => ({ info: vi.fn() });

  beforeAll(() => {
    knex = createTestKnex();
  });
  afterAll(async () => {
    await knex.destroy();
  });
  beforeEach(async () => {
    schema = uniqueSchema("dt_floor");
    await knex.raw(`CREATE SCHEMA "${schema}"`);
  });
  afterEach(async () => {
    await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  it("passes a fresh schema (no tables yet) and says so", async () => {
    const logger = log();
    await refuseLegacyDatetimeData(knex, db(), logger);
    expect(logger.info).toHaveBeenCalledWith("[datetime] no legacy datetimes, nothing to do");
  });

  it("passes empty naive columns, timestamptz data and bookkeeping rows (the guard converts them)", async () => {
    await knex.raw(`
      CREATE TABLE "${schema}".events (id serial PRIMARY KEY, start timestamp(6));
      CREATE TABLE "${schema}".news (id serial PRIMARY KEY, published_at timestamptz(6));
      CREATE TABLE "${schema}".strapi_migrations (id serial PRIMARY KEY, name varchar(255), time timestamp);
      INSERT INTO "${schema}".news (published_at) VALUES ('2026-10-01T10:00:00Z');
      INSERT INTO "${schema}".strapi_migrations (name, time) VALUES ('x.js', '2026-10-01 10:00:00');
    `);
    await expect(refuseLegacyDatetimeData(knex, db(), log())).resolves.toBeUndefined();
  });

  it("refuses a naive app column that holds data: upgrade through v0.28.x first", async () => {
    await knex.raw(`
      CREATE TABLE "${schema}".events (id serial PRIMARY KEY, start timestamp(6));
      INSERT INTO "${schema}".events (start) VALUES ('2026-10-25 01:30:00');
    `);
    await expect(refuseLegacyDatetimeData(knex, db(), log())).rejects.toThrow(
      `${LEGACY_DATETIME_MESSAGE} (first table: events)`,
    );
  });
});

/**
 * Through Strapi's own user-migration runner (@strapi/database
 * migrations/users.js): a stand-in file under the real name hands the
 * runner's (trx, db) to the real check, as the shipped stub does through
 * dist. A fresh database records it once and never runs it again; a v0.25+
 * database (the name recorded) never runs it; pre-contract data stops the
 * runner with nothing recorded.
 */
describe.skipIf(!PG_URL)("the datetime migration through Strapi's runner on Postgres 16", () => {
  let knex: RawKnex;
  let schema: string;
  let dir: string;
  const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const hook = globalThis as unknown as {
    __sinnlosCheckUnderTest?: (trx: unknown, db: unknown) => Promise<unknown>;
  };

  function runner() {
    const requireFromCms = createRequire(join(__dirname, "..", "..", "package.json"));
    const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
    const databaseDir = dirname(requireFromStrapi.resolve("@strapi/database/package.json"));
    const { Database } = requireFromStrapi("@strapi/database") as {
      Database: new (config: Record<string, unknown>) => { destroy(): Promise<void> };
    };
    const { createUserMigrationProvider } = requireFromStrapi(
      join(databaseDir, "dist", "migrations", "users.js"),
    ) as {
      createUserMigrationProvider(db: unknown): {
        shouldRun(): Promise<boolean>;
        up(): Promise<void>;
      };
    };
    const db = new Database({
      connection: {
        client: "postgres",
        connection: { connectionString: PG_URL, options: "-c TimeZone=UTC", schema },
        pool: { min: 0, max: 2 },
      },
      settings: { migrations: { dir }, forceMigration: false },
      logger: quietLog,
    });
    return { db, provider: createUserMigrationProvider(db) };
  }
  const recorded = async () =>
    (
      await rows<{ name: string }>(
        knex,
        `SELECT name FROM "${schema}".strapi_migrations ORDER BY id`,
      )
    ).map((row) => row.name);

  beforeAll(() => {
    knex = createTestKnex();
    hook.__sinnlosCheckUnderTest = (trx, db) =>
      refuseLegacyDatetimeData(trx as RawKnex, db as MigrationDb, quietLog);
  });
  afterAll(async () => {
    delete hook.__sinnlosCheckUnderTest;
    await knex.destroy();
  });
  beforeEach(async () => {
    schema = uniqueSchema("dt_runner");
    await knex.raw(`CREATE SCHEMA "${schema}"`);
    dir = mkdtempSync(join(tmpdir(), "sinnlos-migrations-"));
    writeFileSync(
      join(dir, LEGACY_MIGRATION_NAME),
      "module.exports = { up: (trx, db) => globalThis.__sinnlosCheckUnderTest(trx, db) };\n",
    );
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  it("records it once on a fresh database, then never runs it again", async () => {
    const { db, provider } = runner();
    try {
      expect(await provider.shouldRun()).toBe(true);
      await provider.up();
      expect(await provider.shouldRun()).toBe(false);
      expect(await recorded()).toEqual([LEGACY_MIGRATION_NAME]);
    } finally {
      await db.destroy();
    }
  });

  it("skips it on a v0.25+ database that recorded it, whatever its naive columns hold", async () => {
    await knex.raw(`
      CREATE TABLE "${schema}".strapi_migrations (id serial PRIMARY KEY, name varchar(255), time timestamp);
      INSERT INTO "${schema}".strapi_migrations (name, time) VALUES ('${LEGACY_MIGRATION_NAME}', '2026-10-05 10:00:00');
      CREATE TABLE "${schema}".events (id serial PRIMARY KEY, start timestamp(6));
      INSERT INTO "${schema}".events (start) VALUES ('2026-10-25 01:30:00');
    `);
    const { db, provider } = runner();
    try {
      expect(await provider.shouldRun()).toBe(false);
      expect(await recorded()).toEqual([LEGACY_MIGRATION_NAME]);
    } finally {
      await db.destroy();
    }
  });

  it("stops on pre-contract data with nothing recorded", async () => {
    await knex.raw(`
      CREATE TABLE "${schema}".events (id serial PRIMARY KEY, start timestamp(6));
      INSERT INTO "${schema}".events (start) VALUES ('2026-10-25 01:30:00');
    `);
    const { db, provider } = runner();
    try {
      await expect(provider.up()).rejects.toThrow(LEGACY_DATETIME_MESSAGE);
      expect(await provider.shouldRun()).toBe(true);
    } finally {
      await db.destroy();
    }
  });
});
