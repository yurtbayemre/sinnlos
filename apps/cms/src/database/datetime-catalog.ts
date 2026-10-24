/**
 * Postgres catalog access shared by the timestamptz guard
 * (ensure-timestamptz.ts) and the datetime user migration
 * (database/migrations/, refuseLegacyDatetimeData below).
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
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    bindings?: readonly unknown[],
  ): Promise<Row[]>;
}

/** The part of a knex instance or knex transaction the adapters use. */
export interface KnexRawLike {
  raw(sql: string, bindings?: readonly unknown[]): PromiseLike<unknown>;
}

/** A knex instance or transaction as a SqlClient (knex keeps `?` placeholders). */
export function knexSqlClient(knex: KnexRawLike): SqlClient {
  return {
    async query<Row extends object>(
      sql: string,
      bindings: readonly unknown[] = [],
    ): Promise<Row[]> {
      // knex expands an array binding into a list, so array values are
      // always passed as Postgres array literals (pgArrayLiteral) instead.
      const result = (await knex.raw(sql, bindings as unknown[])) as { rows?: Row[] } | undefined;
      return result?.rows ?? [];
    },
  };
}

/**
 * Strapi's own bookkeeping tables. Their `time` columns are created naive
 * (@strapi/database 5.55.1 migrations/storage.js:6-13,
 * schema/storage.js:12-21) and only order rows; the guard converts them.
 */
export const BOOKKEEPING_TABLES: readonly string[] = [
  "strapi_migrations",
  "strapi_migrations_internal",
  "strapi_database_schema",
];

/**
 * The datetime user migration. Until v0.28 it repaired legacy wall clocks;
 * since v0.29 (upgrade floor v0.25.x, where it has run) it only refuses
 * legacy data (refuseLegacyDatetimeData). Its name stays: the guard's
 * interlock looks for it in strapi_migrations, and a fresh install records it.
 */
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

/** Number of the table's rows in which any of the given columns holds a value. */
export async function countRowsWithValues(
  sql: SqlClient,
  schema: string,
  table: string,
  columns: readonly string[],
): Promise<number> {
  if (columns.length === 0) return 0;
  const predicate = columns.map((column) => `${quoteIdent(column)} IS NOT NULL`).join(" OR ");
  const rows = await sql.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${qualifiedTable(schema, table)} WHERE ${predicate}`,
  );
  return Number(rows[0]?.n ?? 0);
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
 * values: every writer runs in UTC (the guard checks).
 */
export function alterToTimestamptzSql(
  schema: string,
  table: string,
  columns: readonly string[],
): string {
  const clauses = columns.map(
    (column) =>
      `ALTER COLUMN ${quoteIdent(column)} TYPE timestamptz(6) USING ${quoteIdent(column)} AT TIME ZONE 'UTC'`,
  );
  return `ALTER TABLE ${qualifiedTable(schema, table)} ${clauses.join(", ")}`;
}

/** True when the datetime user migration is recorded as run. */
export async function legacyMigrationRecorded(sql: SqlClient, schema: string): Promise<boolean> {
  if (!(await tableExists(sql, schema, "strapi_migrations"))) return false;
  const rows = await sql.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${qualifiedTable(schema, "strapi_migrations")} WHERE name = ?) AS found`,
    [LEGACY_MIGRATION_NAME],
  );
  return rows[0]?.found === true;
}

export const LEGACY_DATETIME_MESSAGE =
  "[datetime] This database still has naive timestamp columns with data, written before the datetime " +
  "contract. This release no longer repairs them: upgrade through v0.28.x first (docs/UPGRADE.md). " +
  "Nothing was changed.";

/** The part of Strapi's database the migration reads. */
export interface MigrationDb {
  dialect: { client: string };
  getSchemaName(): string | undefined | null;
}

/**
 * The datetime user migration's body since v0.29. It runs inside Strapi's
 * migration transaction, before the internal migrations and the schema sync
 * (on a fresh install the tables do not exist yet). A naive app column that
 * holds data is a pre-contract wall clock only the v0.28 repair could read:
 * refused, which rolls back and stops the boot. Empty naive columns are left
 * to the guard (afterSync converts them). SQLite stores epoch ms: nothing to do.
 */
export async function refuseLegacyDatetimeData(
  trx: KnexRawLike,
  db: MigrationDb,
  log: { info(message: string): void } = console,
): Promise<void> {
  if (db.dialect.client !== "postgres") return;
  const schema = db.getSchemaName() || "public";
  const sql = knexSqlClient(trx);
  const columns = (await listNaiveColumns(sql, schema)).filter(
    ({ table }) => !BOOKKEEPING_TABLES.includes(table),
  );
  for (const [table, tableColumns] of groupByTable(columns)) {
    if (await columnsHoldValues(sql, schema, table, tableColumns)) {
      throw new Error(`${LEGACY_DATETIME_MESSAGE} (first table: ${table})`);
    }
  }
  log.info("[datetime] no legacy datetimes, nothing to do");
}
