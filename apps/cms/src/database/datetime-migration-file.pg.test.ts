import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LEGACY_DATETIME_MESSAGE, refuseLegacyDatetimeData } from "./datetime-catalog";
import { PG_URL, createTestKnex, uniqueSchema } from "./pg-test-db.test.helper";
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
