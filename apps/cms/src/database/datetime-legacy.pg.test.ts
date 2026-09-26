import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LEGACY_MIGRATION_NAME } from "./datetime-catalog";
import { MISSING_LEGACY_ZONE_MESSAGE, runLegacyDatetimeMigration } from "./datetime-legacy";
import { convertNaiveColumns } from "./ensure-timestamptz";
import { PG_URL, columnType, createTestKnex, isoOf, rows, uniqueSchema } from "./pg-test-db.test.helper";
import { FIXTURE_ROWS, FIXTURE_TABLES } from "./legacy-fixture.test.helper";
import { type RawKnex } from "./strapi-knex.test.helper";

/**
 * The one-time legacy repair against a real Postgres 16 (runs only with
 * SINNLOS_TEST_PG_URL set; CI's `postgres` job sets it).
 *
 * The fixture reproduces the owner's database: the cms wrote UTC wall clocks
 * until the TZ switch on 2026-08-15 (last write 18:40 UTC) and Berlin wall
 * clocks after it (first write at 18:50 UTC, stored as 20:50).
 * θ = 2026-08-15T21:46:42+02:00 (pre-deploy backup + 1 h).
 */

const OWNER_ENV = {
  DATETIME_LEGACY_ZONE: "Europe/Berlin",
  DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T21:46:42+02:00",
};

const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe.skipIf(!PG_URL)("legacy datetime repair on Postgres 16", () => {
  let knex: RawKnex;
  let schema: string;

  const migrationDb = () => ({ dialect: { client: "postgres" }, getSchemaName: () => schema });

  async function seed(withRows = true) {
    await knex.raw(`CREATE SCHEMA "${schema}"`);
    await knex.raw(`SET search_path TO "${schema}"`);
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL search_path TO "${schema}"`);
      await trx.raw(FIXTURE_TABLES);
      if (withRows) await trx.raw(FIXTURE_ROWS);
    });
  }

  async function migrate(env: Record<string, string | undefined>, processZone = "UTC") {
    return knex.transaction((trx) =>
      runLegacyDatetimeMigration(trx, migrationDb(), { env, log: quietLog, processZone, now: new Date("2026-09-26T10:00:00Z") }),
    );
  }

  const iso = (table: string, column: string, where: string, bindings: readonly unknown[] = []) =>
    isoOf(knex, schema, table, column, where, bindings);

  beforeAll(() => {
    knex = createTestKnex({ pool: { min: 1, max: 1 } });
  });

  afterAll(async () => {
    await knex.destroy();
  });

  beforeEach(() => {
    schema = uniqueSchema("dt_legacy");
  });

  afterEach(async () => {
    await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  it("repairs the owner's mixed data and converts every app column to timestamptz", async () => {
    await seed();
    const summary = await migrate(OWNER_ENV);
    expect(summary).toMatchObject({ convertedColumns: 22 });

    // Class B: untouched since before the switch, a UTC wall clock.
    expect(await iso("events", "start", "document_id = 'e1'")).toBe("2026-06-20T16:00:00Z");
    // Class C (both twins): re-published, value never re-entered: UTC.
    expect(await iso("events", "start", "document_id = 'e2' AND published_at IS NULL")).toBe("2026-10-10T08:00:00Z");
    expect(await iso("events", "start", "document_id = 'e2' AND published_at IS NOT NULL")).toBe(
      "2026-10-10T08:00:00Z",
    );
    // ... while its write stamps follow their own value.
    expect(await iso("events", "created_at", "document_id = 'e2' AND published_at IS NULL")).toBe(
      "2026-07-01T09:00:00Z",
    );
    expect(await iso("events", "updated_at", "document_id = 'e2' AND published_at IS NULL")).toBe(
      "2026-09-01T10:00:00Z",
    );
    // Class A: created after the switch; a November event is CET (+1).
    expect(await iso("events", "start", "document_id = 'e3'")).toBe("2026-11-05T17:00:00Z");
    expect(await iso("events", "end", "document_id = 'e3'")).toBe("2026-11-05T19:00:00Z");
    // All-day, corrected and kept: both end up as Berlin midnight of Oct 1.
    expect(await iso("events", "start", "document_id = 'e4'")).toBe("2026-09-30T22:00:00Z");
    expect(await iso("events", "start", "document_id = 'e5'")).toBe("2026-09-30T22:00:00Z");
    // Poll deadline entered after the switch: 23:59:59 Berlin.
    expect(await iso("polls", "closes_at", "document_id = 'p1'")).toBe("2026-08-27T21:59:59Z");
    expect(await iso("announcements", "expires_at", "document_id = 'a1'")).toBe("2026-12-01T00:00:00Z");
    // Berlin-naive telemetry after the switch, UTC before it.
    expect(await iso("search_logs", "created_at", "term = 'after'")).toBe("2026-09-01T10:00:00Z");
    expect(await iso("search_logs", "created_at", "term = 'last before'")).toBe("2026-08-15T18:40:00Z");
    // Session expiries follow their row's created_at, not their own value.
    expect(await iso("strapi_sessions", "expires_at", "session_id = 'new'")).toBe("2026-09-17T12:00:00Z");
    expect(await iso("strapi_sessions", "absolute_expires_at", "session_id = 'new'")).toBe("2026-10-10T12:00:00Z");
    expect(await iso("strapi_sessions", "expires_at", "session_id = 'old'")).toBe("2026-08-22T18:40:00Z");
    // The digest stamp (07:30 Berlin).
    expect(await iso("up_users", "last_digest_at", "username = 'dana'")).toBe("2026-09-14T05:30:00Z");

    // Calendar dates are untouched and stay `date`.
    const [user] = await rows<{ birthday: string; hire_date: string }>(
      knex,
      `SELECT birthday::text, hire_date::text FROM "${schema}".up_users`,
    );
    expect(user).toEqual({ birthday: "1990-10-01", hire_date: "2016-04-01" });
    expect(await columnType(knex, schema, "announcements", "ack_deadline")).toBe("date");

    // Every app instant is timestamptz; bookkeeping is left to the guard.
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp with time zone");
    expect(await columnType(knex, schema, "up_users", "last_digest_at")).toBe("timestamp with time zone");
    expect(await columnType(knex, schema, "strapi_migrations", "time")).toBe("timestamp without time zone");
    expect(await columnType(knex, schema, "strapi_database_schema", "time")).toBe("timestamp without time zone");

    // The audit keeps every old value as text, with its class.
    const audit = await rows<{ class: string; n: string }>(
      knex,
      `SELECT class, count(*)::text AS n FROM "${schema}".datetime_migration_audit GROUP BY class ORDER BY class`,
    );
    const byClass = Object.fromEntries(audit.map((row) => [row.class, Number(row.n)]));
    expect(byClass).toMatchObject({ A: 3, B: 2, C: 3, "C-allday": 1, "expiry-legacy": 2, "expiry-utc": 1 });
    const [old] = await rows<{ old_naive: string; zone: string }>(
      knex,
      `SELECT old_naive, zone FROM "${schema}".datetime_migration_audit
        WHERE table_name = 'events' AND column_name = 'start' AND class = 'A'`,
    );
    expect(old).toEqual({ old_naive: "2026-11-05 18:00:00", zone: "Europe/Berlin" });
  });

  it("accepts any θ inside the switch stretch (18:40 to 20:50 stored)", async () => {
    await seed();
    await migrate({ DATETIME_LEGACY_ZONE: "Europe/Berlin", DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T20:41:00Z" });
    expect(await iso("search_logs", "created_at", "term = 'last before'")).toBe("2026-08-15T18:40:00Z");
    expect(await iso("search_logs", "created_at", "term = 'first after'")).toBe("2026-08-15T18:50:00Z");
  });

  it("documents the limit: a θ in a long quiet stretch before the switch passes the check", async () => {
    // θ = 12:00 UTC on the 15th sits between writes on 1 Jul and 18:40, so
    // the 18:40 stamps are read as Berlin (two hours early). θ must come
    // from the deploy time (pre-deploy backup; report --around), which is
    // why the runbook derives it from B and the report shows its stretch.
    await seed();
    await migrate({ DATETIME_LEGACY_ZONE: "Europe/Berlin", DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T14:00:00+02:00" });
    expect(await iso("search_logs", "created_at", "term = 'last before'")).toBe("2026-08-15T16:40:00Z");
  });

  it("gap check: a θ whose empty stretch is shorter than the offset aborts, nothing changes", async () => {
    await seed();
    await knex.raw(
      `INSERT INTO "${schema}".search_logs (term, result_count, created_at) VALUES ('noise', 0, '2026-08-15 20:00')`,
    );
    await expect(migrate(OWNER_ENV)).rejects.toThrow(/not inside an empty stretch/);
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp without time zone");
    expect(await iso("search_logs", "created_at", "term = 'after'")).toBe("2026-09-01T12:00:00Z");
    const [audit] = await rows<{ found: boolean }>(
      knex,
      `SELECT to_regclass(?) IS NOT NULL AS found`,
      [`"${schema}".datetime_migration_audit`],
    );
    expect(audit.found).toBe(false);
  });

  it("refuses to guess when data exists and DATETIME_LEGACY_ZONE is unset", async () => {
    await seed();
    await expect(migrate({})).rejects.toThrow(MISSING_LEGACY_ZONE_MESSAGE);
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp without time zone");
  });

  it("converts an empty database without any env (fresh install shape)", async () => {
    await seed(false);
    const summary = await migrate({});
    expect(summary).toMatchObject({ convertedColumns: 22, shiftedCells: 0 });
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp with time zone");
  });

  it("does nothing when there are no naive columns (fresh install before schema sync)", async () => {
    await knex.raw(`CREATE SCHEMA "${schema}"`);
    await expect(migrate({})).resolves.toBeNull();
  });

  it("treats the whole database as legacy zone without DATETIME_LEGACY_UTC_UNTIL", async () => {
    await seed();
    await migrate({ DATETIME_LEGACY_ZONE: "Europe/Berlin" });
    expect(await iso("events", "start", "document_id = 'e1'")).toBe("2026-06-20T14:00:00Z");
    expect(await iso("search_logs", "created_at", "term = 'before'")).toBe("2026-07-01T07:00:00Z");
  });

  it("refuses a non-UTC process", async () => {
    await seed();
    await expect(migrate(OWNER_ENV, "Europe/Berlin")).rejects.toThrow(/needs a UTC process/);
  });

  it("runs once through Strapi's own user-migration runner, then never again", async () => {
    await seed();
    const requireFromCms = createRequire(join(__dirname, "..", "..", "package.json"));
    const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
    const databaseDir = dirname(requireFromStrapi.resolve("@strapi/database/package.json"));
    const { Database } = requireFromStrapi("@strapi/database") as {
      Database: new (config: Record<string, unknown>) => {
        connection: RawKnex;
        destroy(): Promise<void>;
      };
    };
    const { createUserMigrationProvider } = requireFromStrapi(
      join(databaseDir, "dist", "migrations", "users.js"),
    ) as {
      createUserMigrationProvider(db: unknown): { shouldRun(): Promise<boolean>; up(): Promise<void> };
    };

    // The runner require()s the file by name; this stand-in has the real
    // name and hands Strapi's (trx, db) to the real repair.
    const dir = mkdtempSync(join(tmpdir(), "sinnlos-migrations-"));
    const hook = globalThis as unknown as { __sinnlosRepairUnderTest?: (trx: unknown, db: unknown) => Promise<unknown> };
    hook.__sinnlosRepairUnderTest = (trx, db) =>
      runLegacyDatetimeMigration(trx as RawKnex, db as { dialect: { client: string }; getSchemaName(): string }, {
        env: OWNER_ENV,
        log: quietLog,
        processZone: "UTC",
      });
    writeFileSync(
      join(dir, LEGACY_MIGRATION_NAME),
      "module.exports = { up: (trx, db) => globalThis.__sinnlosRepairUnderTest(trx, db) };\n",
    );
    const db = new Database({
      connection: {
        client: "postgres",
        connection: { connectionString: PG_URL, options: "-c TimeZone=UTC", schema },
        pool: { min: 0, max: 2 },
      },
      settings: { migrations: { dir }, forceMigration: false },
      logger: quietLog,
    });
    try {
      const provider = createUserMigrationProvider(db);
      expect(await provider.shouldRun()).toBe(true);
      await provider.up();
      expect(await provider.shouldRun()).toBe(false);

      const recorded = await rows<{ name: string }>(knex, `SELECT name FROM "${schema}".strapi_migrations ORDER BY id`);
      expect(recorded.map((row) => row.name)).toEqual(["earlier.js", LEGACY_MIGRATION_NAME]);
      expect(await iso("events", "start", "document_id = 'e3'")).toBe("2026-11-05T17:00:00Z");

      // A second run (e.g. a crash before the runner recorded it) finds
      // nothing left to repair.
      await expect(migrate(OWNER_ENV)).resolves.toBeNull();
      expect(await iso("events", "start", "document_id = 'e3'")).toBe("2026-11-05T17:00:00Z");

      // Afterwards the guard converts the bookkeeping columns; the interlock
      // is satisfied because the repair is recorded.
      const guardHost = {
        db: { connection: knex, dialect: { client: "postgres" }, getSchemaName: () => schema },
        log: quietLog,
        hook: () => ({ register: () => undefined }),
      };
      const converted = await convertNaiveColumns(guardHost, { processZone: "UTC" });
      expect(converted.map(({ table, column }) => `${table}.${column}`).sort()).toEqual([
        "strapi_database_schema.time",
        "strapi_migrations.time",
      ]);
    } finally {
      await db.destroy();
      delete hook.__sinnlosRepairUnderTest;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
