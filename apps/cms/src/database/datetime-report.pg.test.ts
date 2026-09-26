import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  connectionConfig,
  openReadOnlySession,
  runReport,
  type PgClientCtor,
} from "../../scripts/datetime-migration-report";
import { readLegacySettings, runLegacyDatetimeMigration } from "./datetime-legacy";
import { FIXTURE_ROWS, FIXTURE_TABLES } from "./legacy-fixture.test.helper";
import { PG_URL, columnType, createTestKnex, isoOf, rows, uniqueSchema } from "./pg-test-db.test.helper";
import { requireCmsDependency, type RawKnex } from "./strapi-knex.test.helper";

/**
 * The read-only report CLI on the owner fixture (runs only with
 * SINNLOS_TEST_PG_URL set), through the CLI's own session: a read-only
 * connection and a BEGIN READ ONLY transaction per side, as in production.
 * A second schema stands in for the restored pre-switch dump of 2026-06-24.
 */
const { Client } = requireCmsDependency<{ Client: PgClientCtor }>("pg");
const OWNER = readLegacySettings({
  DATETIME_LEGACY_ZONE: "Europe/Berlin",
  DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T21:46:42+02:00",
});
const LATE_THETA = readLegacySettings({
  DATETIME_LEGACY_ZONE: "Europe/Berlin",
  DATETIME_LEGACY_UTC_UNTIL: "2027-08-15T21:46:42+02:00",
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

  type ReportRun = { all?: boolean; around?: string; baseline?: boolean; settings?: typeof OWNER };

  async function reportResult(options: ReportRun = {}) {
    const lines: string[] = [];
    const main = await openReadOnlySession(Client, connectionConfig({}, PG_URL));
    const base = options.baseline ? await openReadOnlySession(Client, connectionConfig({}, PG_URL)) : null;
    try {
      const { lookupErrors } = await runReport(
        main.sql,
        {
          schema,
          settings: options.settings ?? OWNER,
          appTimeZone: "Europe/Berlin",
          now: new Date("2026-09-26T10:00:00Z"),
          all: options.all,
          around: options.around,
          baseline: base ? { sql: base.sql, schema: baselineSchema } : undefined,
        },
        (line = "") => lines.push(line),
      );
      return { text: lines.join("\n"), lookupErrors };
    } finally {
      await main.close();
      await base?.close();
    }
  }

  const report = async (options: ReportRun = {}) => (await reportResult(options)).text;

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

  it("names the event times in a DST change hour, with both readings, before and after the repair", async () => {
    // Entered after the switch for 02:30 on 2026-10-25: the Berlin clock
    // shows 02:30 twice that night.
    await knex.raw(`
      INSERT INTO "${schema}".events (document_id, title, start, all_day, created_at, updated_at, published_at)
        VALUES ('e6', 'Night shift', '2026-10-25 02:30', false, '2026-09-10 14:00', '2026-09-10 14:00', '2026-09-10 14:00');
    `);
    const before = await report();
    expect(before).toMatch(/DST change hour \(read as standard time\): 1, 1 of them event, poll or announcement times/);
    expect(before).toMatch(/events#7 doc e6 "Night shift" start = 2026-10-25 02:30:00 \[A\]/);
    expect(before).toContain(
      "repeated hour; repaired as 2026-10-25 02:30:00 Europe/Berlin (2026-10-25T01:30:00.000Z), " +
        "the other reading is 2026-10-25 02:30:00 Europe/Berlin (2026-10-25T00:30:00.000Z)",
    );

    await knex.transaction((trx) =>
      runLegacyDatetimeMigration(trx, { dialect: { client: "postgres" }, getSchemaName: () => schema }, {
        env: { DATETIME_LEGACY_ZONE: "Europe/Berlin", DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T21:46:42+02:00" },
        log: { info: () => undefined, warn: () => undefined },
        processZone: "UTC",
        now: new Date("2026-09-26T10:00:00Z"),
      }),
    );
    const after = await report();
    expect(after).toMatch(/times the repair read in a DST change hour: 1/);
    expect(after).toMatch(/events#7 doc e6 "Night shift" start = 2026-10-25 02:30:00 Europe\/Berlin \[A, run [^\]]+\]/);
    expect(after).toContain("the other reading is 2026-10-25 02:30:00 Europe/Berlin (2026-10-25T00:30:00.000Z)");
    expect(after).toMatch(/now in Europe\/Berlin: published #7 2026-10-25 02:30:00/);
    // The stored instant is the second (CET) 02:30, 01:30Z.
    expect(await isoOf(knex, schema, "events", "start", "document_id = 'e6'")).toBe("2026-10-25T01:30:00Z");
  });

  it("says why the gap check fails when θ cannot be tested", async () => {
    const text = await report({ settings: LATE_THETA });
    expect(text).toContain("Gap check: FAILS (the migration would abort). No stamps on one side of θ");
    expect(text).toMatch(/ {2}- θ \(2027-08-15T19:46:42\.000Z\) lies in the future/);
    expect(text).toMatch(/ {2}- no write-time stamp lies at or after θ/);
  });

  it("--around lists the stamps near the pre-deploy backup and marks the switch gap", async () => {
    const text = await report({ around: "2026-08-15T20:46:42+02:00" });
    expect(text).toMatch(/2026-08-15 18:40:00 {2}search_logs\.created_at#2[\s\S]*----- gap 2h10m -----[\s\S]*2026-08-15 20:50:00/);
    expect(text).toContain("θ inside [2026-08-15 18:40:00, 2026-08-15 20:50:00) UTC, e.g. 2026-08-15T19:45:00.000Z");
  });

  it("after the repair lists the ambiguous values it recorded, by document, for the review", async () => {
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
    // Republished after the repair with a corrected time: Strapi deletes the
    // published row and creates a new one, so the audited row id is gone.
    await knex.raw(`
      DELETE FROM "${schema}".events WHERE id = 3;
      INSERT INTO "${schema}".events (id, document_id, title, start, all_day, created_at, updated_at, published_at)
        VALUES (7, 'e2', 'Town hall', '2026-10-10 06:00+00', false, '2026-07-01 09:00+00', now(), now());
    `);
    const { text, lookupErrors } = await reportResult();
    expect(lookupErrors).toBe(0);
    expect(text).toContain("Nothing to repair: every app column is already timestamptz.");
    expect(text).toContain("Ambiguous values the repair recorded in datetime_migration_audit: 4, 4 still open");
    // Named by document and label, with the document's rows as they are now.
    expect(text).toMatch(
      /events#5 doc e4 "Offsite \(corrected\)" start = 2026-10-01 00:00:00 \[C-allday, run 2026-09-26T10:00:00\.000Z, repaired as Europe\/Berlin\]\n.*\n.*\n {6}now in Europe\/Berlin: published #5 2026-10-01 00:00:00/,
    );
    expect(text).toMatch(/events#6 doc e5 "Offsite \(kept\)" start = 2026-09-30 22:00:00 \[C, run [^\]]+, repaired as UTC\]/);
    expect(text).toMatch(
      /events#3 doc e2 "Town hall" start = 2026-10-10 08:00:00 \[C, [^\]]+\]\n.*\n.*\n {6}now in Europe\/Berlin: draft #2 2026-10-10 10:00:00, published #7 2026-10-10 08:00:00/,
    );
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

  it("--baseline: a lookup that fails or cannot be made is named, and later lookups still answer", async () => {
    // Two more class C values in the live data.
    await knex.raw(`
      INSERT INTO "${schema}".announcements (document_id, title, expires_at, created_at, updated_at, published_at)
        VALUES ('a2', 'Winter notice', '2026-12-20 00:00', '2026-07-01 09:00', '2026-09-01 12:00', '2026-09-01 12:00');
      INSERT INTO "${schema}".polls (document_id, question, closes_at, created_at, updated_at, published_at)
        VALUES ('p2', 'Offsite date?', '2026-12-01 23:59:59', '2026-07-01 09:00', '2026-09-01 12:00', '2026-09-01 12:00');
    `);
    // A baseline of an older shape: announcements.expires_at is text (the
    // lookup's to_char fails inside the READ ONLY transaction) and there is
    // no polls table at all.
    await seed(
      baselineSchema,
      `INSERT INTO events (document_id, title, start, all_day, created_at, updated_at, published_at) VALUES
         ('e2', 'Town hall', '2026-10-10 08:00', false, '2026-07-01 09:00', '2026-07-01 09:00', NULL),
         ('e2', 'Town hall', '2026-10-10 08:00', false, '2026-07-01 09:00', '2026-07-01 09:00', '2026-07-01 09:00'),
         ('e5', 'Offsite (kept)', '2026-09-30 20:00', true, '2026-07-01 09:00', '2026-07-01 09:00', '2026-07-01 09:00');`,
    );
    await knex.raw(`
      ALTER TABLE "${baselineSchema}".announcements ALTER COLUMN expires_at TYPE text;
      INSERT INTO "${baselineSchema}".announcements (document_id, title, expires_at, published_at)
        VALUES ('a2', 'Winter notice', '20.12.2026', '2026-07-01 09:00');
      DROP TABLE "${baselineSchema}".polls;
    `);
    const { text, lookupErrors } = await reportResult({ all: true, baseline: true });
    expect(text).toMatch(/announcements#2 doc a2[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: LOOKUP FAILED \(.*to_char/);
    // The failure did not abort the transaction: the next lookups still answer.
    expect(text).toMatch(/events#2 doc e2[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: unchanged since the baseline dump/);
    expect(text).toMatch(/events#6 doc e5[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: was 2026-09-30 20:00:00: changed since/);
    expect(text).toMatch(/events#5 doc e4[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: not in the baseline dump \(created later\)/);
    expect(text).toMatch(/polls#2 doc p2[^\n]*\n[^\n]*\n[^\n]*\n\s+baseline: no table polls in the baseline dump's schema/);
    expect(text).toContain("1 baseline lookup(s) FAILED");
    expect(lookupErrors).toBe(1);
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
