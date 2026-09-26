import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connectionConfig, runReport } from "../../scripts/datetime-migration-report";
import { knexSqlClient } from "./datetime-catalog";
import { readLegacySettings, runLegacyDatetimeMigration } from "./datetime-legacy";
import { FIXTURE_ROWS, FIXTURE_TABLES } from "./legacy-fixture.test.helper";
import { PG_URL, columnType, createTestKnex, rows, uniqueSchema } from "./pg-test-db.test.helper";
import { type RawKnex } from "./strapi-knex.test.helper";

/**
 * The read-only report CLI on the owner fixture (runs only with
 * SINNLOS_TEST_PG_URL set). A second schema stands in for the restored
 * pre-switch dump of 2026-06-24.
 */
const OWNER = readLegacySettings({
  DATETIME_LEGACY_ZONE: "Europe/Berlin",
  DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T21:46:42+02:00",
});

describe.skipIf(!PG_URL)("datetime repair report (read-only) on Postgres 16", () => {
  let knex: RawKnex;
  let schema: string;
  let baselineSchema: string;

  async function seed(target: string, sqlRows: string) {
    await knex.raw(`CREATE SCHEMA "${target}"`);
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL search_path TO "${target}"`);
      await trx.raw(FIXTURE_TABLES);
      if (sqlRows) await trx.raw(sqlRows);
    });
  }

  async function report(options: { all?: boolean; around?: string; baseline?: boolean } = {}) {
    const lines: string[] = [];
    await runReport(
      knexSqlClient(knex),
      {
        schema,
        settings: OWNER,
        appTimeZone: "Europe/Berlin",
        now: new Date("2026-09-26T10:00:00Z"),
        all: options.all,
        around: options.around,
        baseline: options.baseline ? { sql: knexSqlClient(knex), schema: baselineSchema } : undefined,
      },
      (line = "") => lines.push(line),
    );
    return lines.join("\n");
  }

  beforeAll(() => {
    knex = createTestKnex({ pool: { min: 1, max: 2 } });
  });

  afterAll(async () => {
    await knex.destroy();
  });

  beforeEach(async () => {
    schema = uniqueSchema("dt_report");
    baselineSchema = uniqueSchema("dt_june");
    await seed(schema, FIXTURE_ROWS);
  });

  afterEach(async () => {
    await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await knex.raw(`DROP SCHEMA IF EXISTS "${baselineSchema}" CASCADE`);
  });

  it("reports the plan, the gap and the open ambiguous values with both readings, changing nothing", async () => {
    const text = await report();
    expect(text).toContain("repair recorded in strapi_migrations: no");
    expect(text).toMatch(/Gap check: OK\. 130\.0 min between 2026-08-15 18:40:00 .* and 2026-08-15 20:50:00/);
    expect(text).toMatch(/events\.start\s+B=1 C=3 A=1 C-allday=1/);
    // E2 (both twins) is class C and upcoming: both readings in Berlin time.
    expect(text).toMatch(/events#2 doc e2 "Town hall" start = 2026-10-10 08:00:00 \[C, migration: read as UTC\]/);
    expect(text).toContain("read as UTC:             2026-10-10 10:00:00 Europe/Berlin");
    expect(text).toContain("read as Europe/Berlin    2026-10-10 08:00:00 Europe/Berlin");
    // Read-only: nothing converted, no audit table.
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp without time zone");
    const [audit] = await rows<{ found: boolean }>(knex, "SELECT to_regclass(?) IS NOT NULL AS found", [
      `"${schema}".datetime_migration_audit`,
    ]);
    expect(audit.found).toBe(false);
  });

  it("--around lists the stamps near the pre-deploy backup and marks the switch gap", async () => {
    const text = await report({ around: "2026-08-15T20:46:42+02:00" });
    expect(text).toMatch(/2026-08-15 18:40:00 {2}search_logs\.created_at#2[\s\S]*----- gap 2h10m -----[\s\S]*2026-08-15 20:50:00/);
    expect(text).toContain("θ inside [2026-08-15 18:40:00, 2026-08-15 20:50:00) UTC, e.g. 2026-08-15T19:45:00.000Z");
  });

  it("after the repair lists the ambiguous values it recorded, for the review", async () => {
    await knex.transaction((trx) =>
      runLegacyDatetimeMigration(trx, { dialect: { client: "postgres" }, getSchemaName: () => schema }, {
        env: {
          DATETIME_LEGACY_ZONE: "Europe/Berlin",
          DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T21:46:42+02:00",
        },
        log: { info: () => undefined, warn: () => undefined },
        processZone: "UTC",
        now: new Date("2026-09-26T10:00:00Z"),
      }),
    );
    const text = await report();
    expect(text).toContain("Nothing to repair: every app column is already timestamptz.");
    expect(text).toContain("Ambiguous values the repair recorded in datetime_migration_audit: 4, 4 still open");
    expect(text).toMatch(
      /events#5 start = 2026-10-01 00:00:00 \[C-allday, run 2026-09-26T10:00:00\.000Z, repaired as Europe\/Berlin\]/,
    );
    expect(text).toMatch(/events#6 start = 2026-09-30 22:00:00 \[C, run [^\]]+, repaired as UTC\]/);
  });

  it("--baseline tells unchanged values from values edited since the dump", async () => {
    // June dump: E2 exists with the same start; E5 had another time then.
    await seed(
      baselineSchema,
      `INSERT INTO events (document_id, title, start, all_day, created_at, updated_at, published_at) VALUES
         ('e2', 'Town hall', '2026-10-10 08:00', false, '2026-07-01 09:00', '2026-07-01 09:00', NULL),
         ('e2', 'Town hall', '2026-10-10 08:00', false, '2026-07-01 09:00', '2026-07-01 09:00', '2026-07-01 09:00'),
         ('e5', 'Offsite (kept)', '2026-09-30 20:00', true, '2026-07-01 09:00', '2026-07-01 09:00', '2026-07-01 09:00');`,
    );
    const text = await report({ all: true, baseline: true });
    expect(text).toMatch(/events#2 doc e2[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: unchanged since the baseline dump/);
    expect(text).toMatch(/events#6 doc e5[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: was 2026-09-30 20:00:00: changed since, review/);
    expect(text).toMatch(/events#5 doc e4[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: not in the baseline dump/);
  });
});

describe("datetime repair report: connection", () => {
  it("builds a read-only pg connection for the cms database or a given URL", () => {
    expect(connectionConfig({ DATABASE_URL: "postgres://a/b" })).toEqual({
      connectionString: "postgres://a/b",
      options: "-c TimeZone=UTC -c default_transaction_read_only=on",
    });
    expect(connectionConfig({ DATABASE_HOST: "db", DATABASE_PASSWORD: "x" }, undefined)).toMatchObject({
      host: "db",
      port: 5432,
      database: "sinnlos",
      user: "sinnlos",
      options: "-c TimeZone=UTC -c default_transaction_read_only=on",
    });
  });
});
