import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG_URL, createTestKnex, rows, uniqueSchema } from "../database/pg-test-db.test.helper";
import { type RawKnex } from "../database/strapi-knex.test.helper";
import { MAX_ROW_ID, parseEntryRef } from "./entry-id";

/**
 * The id checks of utils/entry-id.ts against a real Postgres 16 (runs only
 * with SINNLOS_TEST_PG_URL set, CI job `datetime`). Strapi binds a lookup
 * value as a parameter of the int4 `id` or the varchar `document_id`
 * column, as done here with knex:
 *  - every value parseEntryRef accepts runs without an error,
 *  - the values it refuses are ones Postgres rejects in an int4 lookup
 *    (the 500 of EVT-ICS-ID), so the guard is what keeps them out.
 */
describe.skipIf(!PG_URL)("entry ids on Postgres 16", () => {
  let knex: RawKnex;
  let schema: string;

  beforeAll(async () => {
    knex = createTestKnex();
    schema = uniqueSchema("entry_id");
    await knex.raw(`CREATE SCHEMA "${schema}"`);
    await knex.raw(`
      CREATE TABLE "${schema}".events (id serial PRIMARY KEY, document_id varchar(255));
      INSERT INTO "${schema}".events (document_id) VALUES ('k3v9q2m8x7c4b1n6p5z0r2t8');
    `);
  });

  afterAll(async () => {
    await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await knex.destroy();
  });

  const byId = (value: unknown) =>
    rows<{ n: string }>(knex, `SELECT count(*) AS n FROM "${schema}".events WHERE id = ?`, [value]);
  const byDocumentId = (value: unknown) =>
    rows<{ n: string }>(
      knex,
      `SELECT count(*) AS n FROM "${schema}".events WHERE document_id = ?`,
      [value],
    );

  it("runs every accepted value", async () => {
    const cases: Array<[input: string | number, matches: number]> = [
      ["1", 1],
      [1, 1],
      ["2", 0],
      [String(MAX_ROW_ID), 0],
      [MAX_ROW_ID, 0],
      ["k3v9q2m8x7c4b1n6p5z0r2t8", 1],
      ["zzzzzzzzzzzzzzzzzzzzzzzz", 0],
    ];
    for (const [input, matches] of cases) {
      const ref = parseEntryRef(input);
      expect(ref, String(input)).not.toBeNull();
      const [row] = "id" in ref ? await byId(ref.id) : await byDocumentId(ref.documentId);
      expect(Number(row.n), String(input)).toBe(matches);
    }
  });

  it("refuses exactly what an int4 lookup rejects", async () => {
    for (const input of [
      "abc",
      "1.5",
      "1e3",
      " ",
      String(MAX_ROW_ID + 1),
      "99999999999999999999",
      1e20,
      Infinity,
    ]) {
      expect(parseEntryRef(input), String(input)).toBeNull();
      await expect(byId(input), String(input)).rejects.toMatchObject({
        code: expect.stringMatching(/^(22P02|22003)$/),
      });
    }
  });
});
