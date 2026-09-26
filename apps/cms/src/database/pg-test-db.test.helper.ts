/**
 * Test support for the Postgres integration suites (*.pg.test.ts). They run
 * only when SINNLOS_TEST_PG_URL points at a Postgres 16 the tests may create
 * and drop schemas in (CI: the postgres:16 service of the `postgres` job;
 * locally: a throwaway container, see docs/DEPLOYMENT.md "Datetime
 * contract"). Every suite works in its own schema.
 */
import { loadStrapiKnex, type RawKnex } from "./strapi-knex.test.helper";

export const PG_URL = process.env.SINNLOS_TEST_PG_URL ?? "";

/** knex on the test database, with the session pin of config/database.ts. */
export function createTestKnex(options: { pinUtc?: boolean; pool?: { min: number; max: number } } = {}): RawKnex {
  return loadStrapiKnex()({
    client: "pg",
    connection: {
      connectionString: PG_URL,
      ...(options.pinUtc === false ? {} : { options: "-c TimeZone=UTC" }),
    },
    pool: options.pool ?? { min: 0, max: 4 },
  });
}

export function uniqueSchema(prefix: string): string {
  return `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function rows<T>(knex: RawKnex, sql: string, bindings: readonly unknown[] = []): Promise<T[]> {
  const result = (await knex.raw(sql, bindings)) as { rows: T[] };
  return result.rows;
}

/** A column's type as Postgres names it (e.g. "timestamp with time zone"). */
export async function columnType(knex: RawKnex, schema: string, table: string, column: string): Promise<string> {
  const [row] = await rows<{ data_type: string }>(
    knex,
    `SELECT data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [schema, table, column],
  );
  return row?.data_type ?? "missing";
}

/**
 * A timestamptz cell as ISO-Z, formatted by Postgres (independent of the
 * process zone and of pg's type parsers).
 */
export async function isoOf(
  knex: RawKnex,
  schema: string,
  table: string,
  column: string,
  where: string,
  bindings: readonly unknown[] = [],
): Promise<string | null> {
  const [row] = await rows<{ iso: string | null }>(
    knex,
    `SELECT to_char("${column}" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iso
       FROM "${schema}"."${table}" WHERE ${where}`,
    bindings,
  );
  return row?.iso ?? null;
}
