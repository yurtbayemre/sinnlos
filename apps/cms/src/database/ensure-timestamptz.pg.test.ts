import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LEGACY_MIGRATION_NAME } from "./datetime-catalog";
import {
  assertTimestamptzContract,
  convertNaiveColumns,
  prepareDatetimeContract,
  type GuardHost,
} from "./ensure-timestamptz";
import { PG_URL, columnType, createTestKnex, isoOf, rows, uniqueSchema } from "./pg-test-db.test.helper";
import { type RawKnex } from "./strapi-knex.test.helper";

/**
 * The timestamptz guard against a real Postgres 16 (runs only with
 * SINNLOS_TEST_PG_URL set). Covers the decision's integration cases: fresh
 * conversion with preserved instants, a naive column added or re-created by
 * a later sync (what Strapi's `.alter()` emits for a `column` override),
 * Date bindings round-tripping in every process zone (`pnpm test:tz`), the
 * pooled session zone, and a table locked by another session.
 */
describe.skipIf(!PG_URL)("timestamptz guard on Postgres 16", () => {
  let knex: RawKnex;
  let schema: string;
  let otherSchema: string;

  const host = (connection: RawKnex = knex) => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const strapi: GuardHost = {
      db: { connection, dialect: { client: "postgres" }, getSchemaName: () => schema },
      log,
      hook: () => ({ register: () => undefined }),
    };
    return { strapi, log };
  };
  const UTC = { processZone: "UTC", env: {} };

  beforeAll(() => {
    knex = createTestKnex();
  });

  afterAll(async () => {
    await knex.destroy();
  });

  beforeEach(async () => {
    schema = uniqueSchema("dt_guard");
    otherSchema = uniqueSchema("dt_other");
    await knex.raw(`CREATE SCHEMA "${schema}"`);
    await knex.raw(`CREATE SCHEMA "${otherSchema}"`);
    await knex.raw(`
      CREATE TABLE "${schema}".events (id serial PRIMARY KEY, start timestamp(6), created_at timestamp(6));
      CREATE TABLE "${schema}".up_users (id serial PRIMARY KEY, birthday date, lesson_time time(3),
        epoch_ms bigint, last_digest_at timestamp(6));
      CREATE TABLE "${schema}".strapi_migrations (id serial PRIMARY KEY, name varchar(255), time timestamp);
      CREATE TABLE "${otherSchema}".foreign_log (id serial PRIMARY KEY, at timestamp(6));
      INSERT INTO "${schema}".events (start, created_at) VALUES ('2026-10-25 01:30:00', '2026-09-24 10:00:00.123456');
      INSERT INTO "${schema}".up_users (birthday, lesson_time, epoch_ms, last_digest_at)
        VALUES ('1990-10-01', '09:30', 1790000000000, '2026-09-24 05:30:00');
      INSERT INTO "${schema}".strapi_migrations (name, time) VALUES ('${LEGACY_MIGRATION_NAME}', '2026-09-26 10:00:00');
      INSERT INTO "${otherSchema}".foreign_log (at) VALUES ('2026-09-24 10:00:00');
    `);
  });

  afterEach(async () => {
    await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await knex.raw(`DROP SCHEMA IF EXISTS "${otherSchema}" CASCADE`);
  });

  it("converts every naive column of the schema, reading the wall clock as UTC", async () => {
    const { strapi } = host();
    const converted = await convertNaiveColumns(strapi, UTC);
    expect(converted.map(({ table, column }) => `${table}.${column}`)).toEqual([
      "events.start",
      "events.created_at",
      "strapi_migrations.time",
      "up_users.last_digest_at",
    ]);
    expect(await isoOf(knex, schema, "events", "start", "id = 1")).toBe("2026-10-25T01:30:00Z");
    expect(await isoOf(knex, schema, "up_users", "last_digest_at", "id = 1")).toBe("2026-09-24T05:30:00Z");
    // Microseconds survive.
    const [micro] = await rows<{ v: string }>(
      knex,
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS v FROM "${schema}".events`,
    );
    expect(micro.v).toBe("10:00:00.123456");
    // date, time and epoch columns are no instants; another schema is not ours.
    expect(await columnType(knex, schema, "up_users", "birthday")).toBe("date");
    expect(await columnType(knex, schema, "up_users", "lesson_time")).toBe("time without time zone");
    expect(await columnType(knex, schema, "up_users", "epoch_ms")).toBe("bigint");
    expect(await columnType(knex, otherSchema, "foreign_log", "at")).toBe("timestamp without time zone");
    // Idempotent: nothing left, no DDL on the next boot.
    expect(await convertNaiveColumns(strapi, UTC)).toEqual([]);
  });

  it("re-converts a column that a later sync re-created naive, without moving the instant", async () => {
    const { strapi } = host();
    await convertNaiveColumns(strapi, UTC);
    // What knex emits for Strapi's datetime .alter(): a naive type, cast in
    // the (UTC) session.
    await knex.raw(`ALTER TABLE "${schema}".events ALTER COLUMN start TYPE timestamp(6) USING start::timestamp(6)`);
    await knex.raw(`ALTER TABLE "${schema}".events ADD COLUMN ends_at timestamp(6)`);
    await knex.raw(`CREATE TABLE "${schema}".kudos (id serial PRIMARY KEY, created_at timestamp(6))`);
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp without time zone");

    const converted = await convertNaiveColumns(strapi, UTC);
    expect(converted.map(({ table, column }) => `${table}.${column}`)).toEqual([
      "events.start",
      "events.ends_at",
      "kudos.created_at",
    ]);
    expect(await isoOf(knex, schema, "events", "start", "id = 1")).toBe("2026-10-25T01:30:00Z");
    expect(await columnType(knex, schema, "events", "created_at")).toBe("timestamp with time zone");
  });

  it("round-trips Date bindings as instants whatever zone the process runs in", async () => {
    const { strapi } = host();
    await convertNaiveColumns(strapi, UTC);
    // 01:30Z on 2026-10-25 is in Berlin's repeated hour: a naive column
    // written by a Berlin process could not tell it apart; timestamptz can.
    const instant = new Date("2026-10-25T01:30:00.000Z");
    await knex.raw(`INSERT INTO "${schema}".events (start, created_at) VALUES (?, ?)`, [instant, new Date()]);
    const found = await rows<{ start: Date }>(
      knex,
      `SELECT start FROM "${schema}".events WHERE start >= ? AND start < ? ORDER BY id`,
      [new Date("2026-10-25T01:00:00Z"), new Date("2026-10-25T02:00:00Z")],
    );
    expect(found.map((row) => row.start.toISOString())).toEqual([
      "2026-10-25T01:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
  });

  it("pins every pooled session to UTC and refuses a session in another zone", async () => {
    const sessions = await Promise.all(
      [1, 2, 3].map(() => rows<{ tz: string }>(knex, "SELECT current_setting('TimeZone') AS tz")),
    );
    expect(sessions.map(([row]) => row.tz)).toEqual(["UTC", "UTC", "UTC"]);

    // A session in another zone (e.g. behind a pooler that drops the
    // startup options) fails the boot. One pooled connection, so the SET
    // applies to the session the check uses.
    const unpinned = createTestKnex({ pinUtc: false, pool: { min: 1, max: 1 } });
    try {
      await unpinned.raw("SET TimeZone = 'Europe/Berlin'");
      await expect(prepareDatetimeContract(host(unpinned).strapi, UTC)).rejects.toThrow(/not UTC/);
    } finally {
      await unpinned.destroy();
    }
  });

  it("logs a table locked by another session, converts the rest, and fails the start until it can convert it", async () => {
    const locker = createTestKnex({ pool: { min: 1, max: 1 } });
    const { strapi, log } = host();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const holder = locker.transaction(async (trx) => {
      await trx.raw(`LOCK TABLE "${schema}".events IN ACCESS SHARE MODE`);
      lockTaken();
      await released;
    });
    try {
      await locked;
      const converted = await convertNaiveColumns(strapi, UTC);
      expect(converted.map(({ table }) => table)).toEqual(["strapi_migrations", "up_users"]);
      expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/could not convert events .*lock timeout/));
      await expect(assertTimestamptzContract(strapi, UTC)).rejects.toThrow(/events\.start/);
    } finally {
      release();
      await holder;
      await locker.destroy();
    }
    await expect(assertTimestamptzContract(strapi, UTC)).resolves.toBeUndefined();
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp with time zone");
  }, 30000);

  it("refuses to read unrepaired data as UTC when the legacy repair is not recorded", async () => {
    await knex.raw(`DELETE FROM "${schema}".strapi_migrations`);
    const { strapi } = host();
    await expect(convertNaiveColumns(strapi, UTC)).rejects.toThrow(/has not run/);
    expect(await columnType(knex, schema, "events", "start")).toBe("timestamp without time zone");
  });
});
