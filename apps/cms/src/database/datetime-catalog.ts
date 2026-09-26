/**
 * Postgres catalog access shared by the timestamptz guard
 * (ensure-timestamptz.ts), the one-time legacy repair (datetime-legacy.ts)
 * and its read-only report CLI (scripts/datetime-migration-report.ts).
 *
 * Why the catalog and not Strapi's inspector: @strapi/database 5.55.1 maps
 * both `timestamp` and `timestamptz` to the root type 'datetime'
 * (dialects/postgresql/schema-inspector.js:77-121) and its diff never
 * compares the time zone argument (schema/diff.js:119-146), so it cannot
 * tell the two apart. pg_attribute can.
 *
 * Scope: every base table (relkind r/p, not a partition) of the configured
 * application schema (DATABASE_SCHEMA, default public), columns of type
 * `timestamp without time zone`. That includes app, component, admin,
 * plugin, token/session and Strapi's bookkeeping tables; `date` and `time`
 * columns, numeric epochs and every other schema are out of scope by
 * construction.
 */

/** Runs one SQL statement with `?` placeholders and returns its rows. */
export interface SqlClient {
  query<Row extends object = Record<string, unknown>>(sql: string, bindings?: readonly unknown[]): Promise<Row[]>;
}

/** The part of a knex instance or knex transaction the adapters use. */
export interface KnexRawLike {
  raw(sql: string, bindings?: readonly unknown[]): PromiseLike<unknown>;
}

/** A knex instance or transaction as a SqlClient (knex keeps `?` placeholders). */
export function knexSqlClient(knex: KnexRawLike): SqlClient {
  return {
    async query<Row extends object>(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
      // knex expands an array binding into a list, so array values are
      // always passed as Postgres array literals (pgArrayLiteral) instead.
      const result = (await knex.raw(sql, bindings as unknown[])) as { rows?: Row[] } | undefined;
      return result?.rows ?? [];
    },
  };
}

/** The part of a node-postgres client the adapter uses. */
export interface PgQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** A node-postgres client as a SqlClient (`?` becomes `$1..$n`). */
export function pgSqlClient(client: PgQueryable): SqlClient {
  return {
    async query<Row extends object>(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
      let index = 0;
      const text = sql.replace(/\?/g, () => `$${++index}`);
      const result = await client.query(text, [...bindings]);
      return result.rows as Row[];
    },
  };
}

/**
 * Strapi's own bookkeeping tables. Their `time` columns are created naive
 * (@strapi/database 5.55.1 migrations/storage.js:105-112,
 * schema/storage.js:12-21) and only order rows. The legacy repair leaves them
 * to the guard, so it never touches the migration runner's own table.
 */
export const BOOKKEEPING_TABLES: readonly string[] = [
  "strapi_migrations",
  "strapi_migrations_internal",
  "strapi_database_schema",
];

/** The repair's audit table (old values as text; it has no naive column). */
export const AUDIT_TABLE = "datetime_migration_audit";

/** The user migration file that performs the one-time legacy repair. */
export const LEGACY_MIGRATION_NAME = "2026.10.05T00.00.00.datetime-timestamptz.js";

export interface NaiveColumn {
  table: string;
  column: string;
}

/** A Postgres identifier, double-quoted. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** "schema"."table" */
export function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** A Postgres array literal for a knex/pg binding ('{1,2}' or '{"a","b"}'). */
export function pgArrayLiteral(values: readonly (string | number)[]): string {
  const items = values.map((value) =>
    typeof value === "number" ? String(value) : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `{${items.join(",")}}`;
}

/** Naive timestamp columns of the schema's base tables, in table/column order. */
export async function listNaiveColumns(sql: SqlClient, schema: string): Promise<NaiveColumn[]> {
  const rows = await sql.query<{ table_name: string; column_name: string }>(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ?
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.atttypid = 'timestamp without time zone'::regtype
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

/** Column name -> Postgres type name for one table. */
export async function tableColumnTypes(sql: SqlClient, schema: string, table: string): Promise<Map<string, string>> {
  const rows = await sql.query<{ column_name: string; type_name: string }>(
    `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type_name
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ? AND c.relname = ? AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, table],
  );
  return new Map(rows.map((row) => [row.column_name, row.type_name]));
}

export async function tableExists(sql: SqlClient, schema: string, table: string): Promise<boolean> {
  const rows = await sql.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ? AND c.relname = ? AND c.relkind IN ('r', 'p')
     ) AS found`,
    [schema, table],
  );
  return rows[0]?.found === true;
}

/** True when any of the table's given columns holds a non-null value. */
export async function columnsHoldValues(
  sql: SqlClient,
  schema: string,
  table: string,
  columns: readonly string[],
): Promise<boolean> {
  if (columns.length === 0) return false;
  const predicate = columns.map((column) => `${quoteIdent(column)} IS NOT NULL`).join(" OR ");
  const rows = await sql.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${qualifiedTable(schema, table)} WHERE ${predicate}) AS found`,
  );
  return rows[0]?.found === true;
}

/** Groups columns by table, keeping order. */
export function groupByTable(columns: readonly NaiveColumn[]): Map<string, string[]> {
  const byTable = new Map<string, string[]>();
  for (const { table, column } of columns) {
    const list = byTable.get(table) ?? [];
    list.push(column);
    byTable.set(table, list);
  }
  return byTable;
}

/**
 * One ALTER TABLE converting the given naive columns to timestamptz(6),
 * reading the stored wall clock as UTC. Only correct for UTC wall-clock
 * values: the guard's (every writer runs in UTC) and the repaired legacy
 * values.
 */
export function alterToTimestamptzSql(schema: string, table: string, columns: readonly string[]): string {
  const clauses = columns.map(
    (column) => `ALTER COLUMN ${quoteIdent(column)} TYPE timestamptz(6) USING ${quoteIdent(column)} AT TIME ZONE 'UTC'`,
  );
  return `ALTER TABLE ${qualifiedTable(schema, table)} ${clauses.join(", ")}`;
}

/** True when the user migration of the legacy repair is recorded as run. */
export async function legacyMigrationRecorded(sql: SqlClient, schema: string): Promise<boolean> {
  if (!(await tableExists(sql, schema, "strapi_migrations"))) return false;
  const rows = await sql.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${qualifiedTable(schema, "strapi_migrations")} WHERE name = ?) AS found`,
    [LEGACY_MIGRATION_NAME],
  );
  return rows[0]?.found === true;
}
