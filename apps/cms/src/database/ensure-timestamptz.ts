/**
 * The timestamptz guard (datetime contract, deep-dive decision 04, C9 with
 * the Codex amendments). Every instant is stored as `timestamptz(6)`, but
 * Strapi 5.55.1 keeps creating `timestamp without time zone`: a new datetime
 * field or content type is always created naive (@strapi/database
 * schema/schema.js:219-240 builds datetime with useTz:false), and a `column`
 * override or a type change re-creates an existing column naive through
 * knex .alter() (schema/builder.js:286-298). The inspector cannot see the
 * difference (datetime-catalog.ts), so this guard reads pg_catalog.
 *
 * Boot sequence (@strapi/core 5.55.1 Strapi.js):
 *  1. register() :326-337 -> prepareDatetimeContract(): logs the zones,
 *     verifies the DB session runs in UTC, remembers the stored schema
 *     marker, and refuses a non-UTC process on a fresh database or while the
 *     legacy repair is still pending.
 *  2. db.init, then the beforeSync hook :358-361 -> refuseNonUtcSchemaSync():
 *     in a non-UTC process, refuses a boot whose schema sync would run a
 *     migration or change the schema, before any of that happens.
 *  3. db.schema.sync() :364: user migrations (the one-time legacy repair
 *     converts every legacy column itself), internal migrations, then the
 *     schema diff creates new columns naive.
 *  4. afterSync hook :391 -> convertNaiveColumns(): one short transaction
 *     per table (SET LOCAL lock_timeout 5s and statement_timeout 60s), ALTER
 *     ... TYPE timestamptz(6) USING col AT TIME ZONE 'UTC'. The hook is an
 *     asyncParallel hook shared with core handlers (providers/registries.js:
 *     29-33, @strapi/utils hooks.js:55-60), so a table another handler still
 *     holds can time out; that is logged and retried in step 5. Its schema
 *     marker comparison is the backstop of step 2.
 *  5. user bootstrap() :408 (after the content-types store is saved and the
 *     plugins bootstrapped, before the server listens) ->
 *     assertTimestamptzContract(): retries what is left and FAILS the start
 *     if any naive column remains. The app never serves with a half-enforced
 *     contract.
 *
 * Conversions read the stored wall clock as UTC. That is only right because
 * every writer that can reach a naive column is UTC: the process must be
 * TZ=UTC whenever there is something to convert (checked), every session
 * runs with TimeZone=UTC (config/database.ts, checked), and legacy values
 * were rewritten by the repair first (interlock: data in a naive app column
 * with the repair not recorded fails the boot).
 *
 * SQLite (local development) is skipped entirely: it stores epoch ms.
 */
import { appTimeZone, isUtcZone, processTimeZone } from "../utils/time";
import {
  BOOKKEEPING_TABLES,
  LEGACY_MIGRATION_NAME,
  alterToTimestamptzSql,
  columnsHoldValues,
  countRowsWithValues,
  groupByTable,
  knexSqlClient,
  legacyMigrationRecorded,
  listNaiveColumns,
  qualifiedTable,
  tableExists,
  type KnexRawLike,
  type NaiveColumn,
  type SqlClient,
} from "./datetime-catalog";

export const LOCK_TIMEOUT = "5s";
export const STATEMENT_TIMEOUT = "60s";

export interface GuardLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface KnexWithTransaction extends KnexRawLike {
  transaction<T>(handler: (trx: KnexRawLike) => Promise<T>): Promise<T>;
}

/**
 * What db.schema.sync() decides on (@strapi/database 5.55.1
 * schema/index.js:88-107): pending migrations, and the stored schema hash
 * against the hash of the schema this boot's models produce.
 */
export interface SchemaSyncState {
  migrations?: { shouldRun(): Promise<boolean> };
  schema?: {
    readonly schema: unknown;
    schemaStorage: {
      read(): Promise<{ hash?: string | null } | null>;
      hashSchema(schema: unknown): string | Promise<string>;
    };
  };
}

/** The slice of the Strapi instance the guard uses. */
export interface GuardHost {
  db: SchemaSyncState & {
    connection: KnexWithTransaction;
    dialect: { client: string };
    getSchemaName(): string | undefined | null;
  };
  log: GuardLogger;
  hook(name: string): { register(handler: (context: unknown) => Promise<void>): unknown };
}

export interface GuardOptions {
  /** Process zone override for tests (default: this process's zone). */
  processZone?: string;
  env?: Record<string, string | undefined>;
}

interface GuardState {
  /** strapi_database_schema's latest row at register(), null on a fresh database. */
  schemaMarker: string | null;
}

const states = new WeakMap<object, GuardState>();

function isPostgres(strapi: GuardHost): boolean {
  return strapi.db.dialect.client === "postgres";
}

function schemaOf(strapi: GuardHost): string {
  return strapi.db.getSchemaName() || "public";
}

function describeColumns(columns: readonly NaiveColumn[]): string {
  return columns.map(({ table, column }) => `${table}.${column}`).join(", ");
}

async function readSchemaMarker(sql: SqlClient, schema: string): Promise<string | null> {
  if (!(await tableExists(sql, schema, "strapi_database_schema"))) return null;
  const rows = await sql.query<{ marker: string }>(
    `SELECT id::text || ':' || coalesce(hash, '') AS marker
       FROM ${qualifiedTable(schema, "strapi_database_schema")}
      ORDER BY time DESC NULLS LAST, id DESC LIMIT 1`,
  );
  return rows[0]?.marker ?? null;
}

async function sessionTimeZone(sql: SqlClient): Promise<string> {
  const rows = await sql.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
  return rows[0]?.tz ?? "";
}

/**
 * register(): zone log, session check, TZ rules for fresh and repair boots.
 * Throws (refusing the boot) before Strapi writes anything.
 */
export async function prepareDatetimeContract(strapi: GuardHost, options: GuardOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const zone = options.processZone ?? processTimeZone();
  // Also validates APP_TIME_ZONE a second time for this process.
  const businessZone = appTimeZone(env);
  strapi.log.info(`[datetime] process time zone ${zone}, APP_TIME_ZONE ${businessZone}`);
  if (!isPostgres(strapi)) return;

  const schema = schemaOf(strapi);
  const sql = knexSqlClient(strapi.db.connection);
  const session = await sessionTimeZone(sql);
  if (!isUtcZone(session)) {
    throw new Error(
      `[datetime] The database session runs in "${session}", not UTC. config/database.ts sends ` +
        "-c TimeZone=UTC; a connection pooler or proxy that drops startup options breaks that. " +
        "Connect the cms to Postgres directly (docs/DEPLOYMENT.md, datetime contract).",
    );
  }

  const schemaMarker = await readSchemaMarker(sql, schema);
  states.set(strapi, { schemaMarker });

  if (isUtcZone(zone)) return;
  const fresh = schemaMarker === null;
  const repairPending = !(await legacyMigrationRecorded(sql, schema));
  if (fresh || repairPending) {
    throw new Error(
      `[datetime] This boot ${fresh ? "creates the database schema" : "runs the one-time datetime repair"} ` +
        `and needs a UTC process, but this one runs in ${zone}. Start the cms with TZ=UTC ` +
        "(the Docker image and compose set it; for local Postgres development add TZ=UTC to apps/cms/.env).",
    );
  }
  if (env.NODE_ENV === "production") {
    strapi.log.warn(
      `[datetime] The cms process runs in ${zone}, not UTC. Stored instants stay correct, but a boot ` +
        "that changes the schema will refuse to start. Set TZ=UTC.",
    );
  }
}

/**
 * beforeSync: a non-UTC process may not run a boot that migrates or changes
 * the schema (amendment 4). Strapi writes during such a boot before the
 * afterSync guard can look: user and internal migrations, the DDL of the
 * schema diff, the schema-storage row, and core afterSync handlers such as
 * the first-published-at migration that run in parallel with the guard and
 * store `new Date()`. A column that such a boot creates naive would take
 * those values as this process's wall clock (pg sends a Date with its
 * offset, and a naive column drops it), and the next UTC boot would convert
 * them as UTC: a permanent shift. This check runs before all of that and
 * mirrors db.schema.sync()'s own conditions. The afterSync marker check
 * stays as a backstop (core beforeSync handlers run in parallel with this
 * one).
 */
export async function refuseNonUtcSchemaSync(strapi: GuardHost, options: GuardOptions = {}): Promise<void> {
  if (!isPostgres(strapi)) return;
  const zone = options.processZone ?? processTimeZone();
  if (isUtcZone(zone)) return;
  const { migrations, schema } = strapi.db;
  if (!migrations || !schema) {
    throw new Error(
      `[datetime] Cannot tell whether this boot changes the database schema (strapi.db.migrations or ` +
        `strapi.db.schema is missing after a Strapi upgrade?), and this process runs in ${zone}. ` +
        "Start the cms with TZ=UTC.",
    );
  }
  let change: string | null = null;
  if (await migrations.shouldRun()) {
    change = "runs database migrations";
  } else {
    const stored = await schema.schemaStorage.read();
    if (!stored) change = "creates the database schema";
    else if (stored.hash !== (await schema.schemaStorage.hashSchema(schema.schema))) {
      change = "changes the database schema";
    }
  }
  if (change) {
    throw new Error(
      `[datetime] This boot ${change} and needs a UTC process, but this one runs in ${zone}. It stopped ` +
        "before Strapi's migrations and schema sync. Start the cms with TZ=UTC (the Docker image and " +
        "compose set it; for local Postgres development add TZ=UTC to apps/cms/.env).",
    );
  }
}

async function convertTable(
  strapi: GuardHost,
  schema: string,
  table: string,
  columns: readonly string[],
): Promise<boolean> {
  try {
    await strapi.db.connection.transaction(async (trx) => {
      const sql = knexSqlClient(trx);
      await sql.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await sql.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await sql.query(alterToTimestamptzSql(schema, table, columns));
    });
    return true;
  } catch (error) {
    strapi.log.error(
      `[datetime] could not convert ${table} (${columns.join(", ")}) to timestamptz: ` +
        `${(error as Error).message}. Retried before the server starts.`,
    );
    return false;
  }
}

/**
 * Converts every naive timestamp column of the schema, one transaction per
 * table. Throws only for conditions a retry cannot fix (non-UTC process,
 * unrepaired legacy data); a failed table is logged and left for the retry.
 */
export async function convertNaiveColumns(strapi: GuardHost, options: GuardOptions = {}): Promise<NaiveColumn[]> {
  if (!isPostgres(strapi)) return [];
  const schema = schemaOf(strapi);
  const sql = knexSqlClient(strapi.db.connection);
  const zone = options.processZone ?? processTimeZone();

  const state = states.get(strapi);
  if (!isUtcZone(zone) && state && (await readSchemaMarker(sql, schema)) !== state.schemaMarker) {
    throw new Error(
      `[datetime] This boot changed the database schema in a process running in ${zone}. ` +
        "Schema-changing boots need TZ=UTC. Restart the cms with TZ=UTC.",
    );
  }

  const naive = await listNaiveColumns(sql, schema);
  if (naive.length === 0) return [];
  if (!isUtcZone(zone)) {
    throw new Error(
      `[datetime] Naive timestamp columns need converting (${describeColumns(naive)}), which is only ` +
        `correct in a UTC process; this one runs in ${zone}. Restart the cms with TZ=UTC.`,
    );
  }

  const byTable = groupByTable(naive);
  if (!(await legacyMigrationRecorded(sql, schema))) {
    // Interlock: before the one-time repair has run, data in an app column
    // may be a legacy wall clock; reading it as UTC would shift it for good.
    const withData: string[] = [];
    for (const [table, columns] of byTable) {
      if (BOOKKEEPING_TABLES.includes(table)) continue;
      if (await columnsHoldValues(sql, schema, table, columns)) withData.push(table);
    }
    if (withData.length > 0) {
      throw new Error(
        `[datetime] Naive timestamp columns hold data (${withData.join(", ")}) but the one-time ` +
          `datetime repair (database/migrations/${LEGACY_MIGRATION_NAME}) has not run. Refusing to ` +
          "read them as UTC. Check that the migration file is deployed and see docs/DEPLOYMENT.md.",
      );
    }
  } else {
    // After the repair a naive app column with data was re-created: by
    // Strapi (a `column` override or a type change, cast in its UTC session:
    // reading it as UTC is right) or by hand. A manual ALTER ... TYPE
    // timestamp in a non-UTC session (psql without PGTZ=UTC) stored that
    // session's wall clock, and this conversion then shifts every value.
    // Nothing here can tell the two apart, so say it with the row count.
    for (const [table, columns] of byTable) {
      if (BOOKKEEPING_TABLES.includes(table)) continue;
      const rowsWithValues = await countRowsWithValues(sql, schema, table, columns);
      if (rowsWithValues === 0) continue;
      strapi.log.warn(
        `[datetime] ${table} (${columns.join(", ")}) is timestamp without time zone again and holds values in ` +
          `${rowsWithValues} row(s); converting them as UTC wall clocks. That is right when Strapi re-created ` +
          "the column; after a manual ALTER in a non-UTC session the values move by that zone's offset " +
          "(docs/DEPLOYMENT.md, datetime contract).",
      );
    }
  }

  const converted: NaiveColumn[] = [];
  for (const [table, columns] of byTable) {
    if (await convertTable(strapi, schema, table, columns)) {
      converted.push(...columns.map((column) => ({ table, column })));
    }
  }
  if (converted.length > 0) {
    strapi.log.info(
      `[datetime] converted ${converted.length} column(s) to timestamptz: ${describeColumns(converted)}`,
    );
  }
  return converted;
}

/**
 * bootstrap(): the last word before the server starts. Retries whatever the
 * afterSync pass could not convert and throws if any naive column remains.
 */
export async function assertTimestamptzContract(strapi: GuardHost, options: GuardOptions = {}): Promise<void> {
  if (!isPostgres(strapi)) return;
  const schema = schemaOf(strapi);
  const sql = knexSqlClient(strapi.db.connection);
  if ((await listNaiveColumns(sql, schema)).length > 0) {
    await convertNaiveColumns(strapi, options);
  }
  const remaining = await listNaiveColumns(sql, schema);
  if (remaining.length > 0) {
    throw new Error(
      `[datetime] ${remaining.length} column(s) are still timestamp without time zone after two ` +
        `conversion attempts: ${describeColumns(remaining)}. The cms does not start with a partially ` +
        "enforced datetime contract; the next start retries (see the errors above, usually a lock held " +
        "by another session).",
    );
  }
}

/** Wires the guard into Strapi's beforeSync and afterSync hooks (call from register()). */
export function registerTimestamptzGuard(strapi: GuardHost, options: GuardOptions = {}): void {
  strapi.hook("strapi::content-types.beforeSync").register(async () => {
    await refuseNonUtcSchemaSync(strapi, options);
  });
  strapi.hook("strapi::content-types.afterSync").register(async () => {
    await convertNaiveColumns(strapi, options);
  });
}
