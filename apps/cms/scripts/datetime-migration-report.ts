/**
 * READ-ONLY report for the one-time datetime repair (datetime contract,
 * deep-dive decision 04, C11). It shows what the user migration
 * database/migrations/2026.10.05T00.00.00.datetime-timestamptz.js would do,
 * with the same rules (src/database/datetime-legacy.ts), and changes nothing:
 * the session runs with default_transaction_read_only=on inside a
 * READ ONLY transaction that is rolled back. Lookups that may fail (a
 * baseline dump with an older schema) run in a savepoint, so one failure
 * cannot abort that transaction for every later query; a failed lookup is
 * reported and makes the CLI exit with status 1.
 *
 * Built with the cms (`strapi build` compiles it to dist/scripts/). Run from
 * apps/cms, e.g. inside the cms container:
 *
 *   node dist/scripts/datetime-migration-report.js [options]
 *
 * Connection: --url <postgres-url>, else DATABASE_URL, else DATABASE_HOST /
 * DATABASE_PORT / DATABASE_NAME / DATABASE_USERNAME / DATABASE_PASSWORD
 * (DATABASE_SSL=true for TLS), schema DATABASE_SCHEMA or --schema.
 * Settings: DATETIME_LEGACY_ZONE / DATETIME_LEGACY_UTC_UNTIL (or
 * --legacy-zone / --utc-until) and APP_TIME_ZONE for the readings.
 *
 * Options:
 *   --around <ISO instant>   list the write stamps around this instant (the
 *                            pre-deploy backup time B) with gaps >= 1h55m
 *                            marked, to locate θ
 *   --all                    list every ambiguous (class C) value, not only
 *                            open or upcoming ones
 *   --baseline <url>         compare the ambiguous values with a restored
 *                            pre-switch dump (--baseline-schema, default
 *                            public)
 *   --now <ISO instant>      "now" for the open/upcoming filter
 */
import * as pgModule from "pg";

import {
  AUDIT_TABLE,
  BOOKKEEPING_TABLES,
  legacyMigrationRecorded,
  listNaiveColumns,
  pgSqlClient,
  qualifiedTable,
  quoteIdent,
  tableColumnTypes,
  tableExists,
  type PgQueryable,
  type SqlClient,
} from "../src/database/datetime-catalog";
import {
  USER_ENTERED_COLUMNS,
  buildLegacyPlan,
  classCounts,
  gapFailureReasons,
  readLegacySettings,
  repairColumns,
  type CellPlan,
  type LegacyPlan,
  type LegacySettings,
} from "../src/database/datetime-legacy";
import {
  appTimeZone,
  formatInstant,
  instantMsOrNull,
  plainDateTimeToInstant,
  toIsoZ,
  wallTimeOccurrence,
} from "../src/utils/time";

export interface ReportOptions {
  schema: string;
  settings: LegacySettings;
  appTimeZone: string;
  now: Date;
  around?: string;
  all?: boolean;
  baseline?: { sql: SqlClient; schema: string };
}

export interface ReportResult {
  plan: LegacyPlan;
  /** Lookups that failed with an unexpected SQL error (the CLI exits 1). */
  lookupErrors: number;
}

type Print = (line?: string) => void;

/**
 * Runs one lookup inside a savepoint of the report's READ ONLY transaction:
 * a statement that fails rolls back to the savepoint instead of aborting the
 * transaction, so every later query still runs. Needs a transaction block
 * (the CLI's BEGIN READ ONLY, openReadOnlySession).
 */
async function inSavepoint<T>(sql: SqlClient, run: () => Promise<T>): Promise<T> {
  await sql.query("SAVEPOINT report_lookup");
  try {
    const result = await run();
    await sql.query("RELEASE SAVEPOINT report_lookup");
    return result;
  } catch (error) {
    await sql.query("ROLLBACK TO SAVEPOINT report_lookup");
    await sql.query("RELEASE SAVEPOINT report_lookup");
    throw error;
  }
}

/** Column name -> type of a table on one side, read once per table (an absent table has none). */
type SchemaCache = (table: string) => Promise<Map<string, string>>;

function schemaCache(sql: SqlClient, schema: string): SchemaCache {
  const tables = new Map<string, Promise<Map<string, string>>>();
  return (table) => {
    let found = tables.get(table);
    if (!found) {
      found = tableColumnTypes(sql, schema, table);
      tables.set(table, found);
    }
    return found;
  };
}

const AROUND_BEFORE_MS = 6 * 3600000;
const AROUND_AFTER_MS = 8 * 3600000;
/** Gaps this long are marked in --around (a switch leaves one of >= 2 h in summer, >= 1 h in winter). */
const MARK_GAP_MINUTES = 115;

function naiveMs(naive: string): number {
  return Date.parse(`${naive.slice(0, 23)}Z`);
}

function naiveShort(naive: string): string {
  return naive.slice(0, 19).replace("T", " ");
}

function reading(naive: string, zone: string, appZone: string, disambiguation: "later" | "earlier" = "later"): string {
  const instant = plainDateTimeToInstant(naive, zone, disambiguation);
  return formatInstant(
    "sv-SE",
    instant,
    { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" },
    appZone,
  );
}

/**
 * The two readings of a legacy-zone wall time in a DST change hour: the one
 * the repair takes (Postgres AT TIME ZONE: the later, standard-time instant
 * of a repeated hour) and the other one. Only a person knows which was meant.
 */
function foldReadings(naive: string, zone: string, appZone: string): string {
  const kind = wallTimeOccurrence(naive, zone) === "repeated" ? "repeated hour" : "skipped hour";
  const one = (disambiguation: "later" | "earlier") =>
    `${reading(naive, zone, appZone, disambiguation)} ${appZone} ` +
    `(${toIsoZ(plainDateTimeToInstant(naive, zone, disambiguation))})`;
  return `${kind}; repaired as ${one("later")}, the other reading is ${one("earlier")}`;
}

function isUserEntered(table: string, column: string): boolean {
  return USER_ENTERED_COLUMNS[table]?.includes(column) ?? false;
}

function minutes(value: number): string {
  const whole = Math.round(value);
  return `${Math.floor(whole / 60)}h${String(whole % 60).padStart(2, "0")}m`;
}

function isOpen(cell: CellPlan, settings: LegacySettings, now: Date): boolean {
  const readings = [plainDateTimeToInstant(cell.naive, "UTC")];
  if (settings.zone) readings.push(plainDateTimeToInstant(cell.naive, settings.zone));
  return readings.some((instant) => instant.getTime() >= now.getTime());
}

async function printAround(print: Print, plan: LegacyPlan, around: string): Promise<void> {
  const centreMs = instantMsOrNull(around);
  if (centreMs === null) throw new Error(`--around needs an ISO instant with an offset, got "${around}"`);
  const stamps = plan.writeStamps
    .filter((stamp) => {
      const ms = naiveMs(stamp.naive);
      return ms >= centreMs - AROUND_BEFORE_MS && ms <= centreMs + AROUND_AFTER_MS;
    })
    .sort((a, b) => (a.naive < b.naive ? -1 : a.naive > b.naive ? 1 : 0));
  print();
  print(
    `Write stamps from 6 h before to 8 h after ${toIsoZ(around)} (stored values: UTC wall clock before the ` +
      "switch, legacy-zone wall clock after it):",
  );
  let suggestion: string | null = null;
  stamps.forEach((stamp, index) => {
    if (index > 0) {
      const gap = (naiveMs(stamp.naive) - naiveMs(stamps[index - 1].naive)) / 60000;
      if (gap >= MARK_GAP_MINUTES) {
        print(`      ----- gap ${minutes(gap)} -----`);
        if (!suggestion && naiveMs(stamp.naive) >= centreMs) {
          const middle = (naiveMs(stamp.naive) + naiveMs(stamps[index - 1].naive)) / 2;
          suggestion =
            `θ inside [${naiveShort(stamps[index - 1].naive)}, ${naiveShort(stamp.naive)}) UTC, e.g. ` +
            toIsoZ(new Date(Math.round(middle / 1000) * 1000));
        }
      }
    }
    print(`  ${naiveShort(stamp.naive)}  ${stamp.where}`);
  });
  if (stamps.length === 0) print("  (no write stamps in this window)");
  print(suggestion ? `First gap >= 1h55m ending after it: ${suggestion}` : "No gap >= 1h55m ends after it.");
}

/** What the baseline dump says about a cell. */
type BaselineLookup =
  | { kind: "value"; value: string | null }
  | { kind: "no-table" }
  | { kind: "no-column" }
  | { kind: "no-row" }
  | { kind: "error"; message: string };

/**
 * The cell's value in the baseline dump: by document and draft/published
 * state where both sides have them (row ids change with every publish), else
 * by row id. An absent table or column is read from the catalog first; any
 * other failure is an error, never a silent "not in the baseline".
 */
async function baselineValue(
  baseline: NonNullable<ReportOptions["baseline"]>,
  baselineSchema: SchemaCache,
  cell: CellPlan,
  draft: boolean | null,
): Promise<BaselineLookup> {
  const columns = await baselineSchema(cell.table);
  if (columns.size === 0) return { kind: "no-table" };
  if (!columns.has(cell.column)) return { kind: "no-column" };
  let where: string;
  let bindings: unknown[];
  if (cell.documentId !== null && columns.has("document_id")) {
    if (draft !== null && columns.has("published_at")) {
      where = "document_id = ? AND (published_at IS NULL) = ?";
      bindings = [cell.documentId, draft];
    } else {
      where = "document_id = ?";
      bindings = [cell.documentId];
    }
  } else if (cell.rowId !== null && columns.has("id")) {
    where = "id = ?";
    bindings = [cell.rowId];
  } else {
    return { kind: "no-row" };
  }
  const value = `to_char(${quoteIdent(cell.column)}, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS v`;
  const order = columns.has("id") ? ` ORDER BY ${quoteIdent("id")}` : "";
  try {
    const found = await inSavepoint(baseline.sql, () =>
      baseline.sql.query<{ v: string | null }>(
        `SELECT ${value} FROM ${qualifiedTable(baseline.schema, cell.table)} WHERE ${where}${order} LIMIT 1`,
        bindings,
      ),
    );
    return found.length === 0 ? { kind: "no-row" } : { kind: "value", value: found[0].v };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

/**
 * Whether the cell's row is a draft: null only for a table without
 * published_at (no draft & publish) or a row without an id. A lookup that
 * fails throws (reported by the caller).
 */
async function isDraftRow(sql: SqlClient, mainSchema: SchemaCache, schema: string, cell: CellPlan): Promise<boolean | null> {
  const columns = await mainSchema(cell.table);
  if (!columns.has("published_at") || !columns.has("id") || cell.rowId === null) return null;
  const [row] = await inSavepoint(sql, () =>
    sql.query<{ draft: boolean }>(
      `SELECT published_at IS NULL AS draft FROM ${qualifiedTable(schema, cell.table)} WHERE id = ?`,
      [cell.rowId],
    ),
  );
  if (!row) throw new Error(`${cell.table}#${cell.rowId} is gone (deleted while the report ran?)`);
  return row.draft;
}

function describeBaseline(lookup: BaselineLookup, cell: CellPlan): string {
  switch (lookup.kind) {
    case "no-table":
      return `      baseline: no table ${cell.table} in the baseline dump's schema: review`;
    case "no-column":
      return `      baseline: no column ${cell.table}.${cell.column} in the baseline dump's schema: review`;
    case "no-row":
      return "      baseline: not in the baseline dump (created later): review";
    case "error":
      return `      baseline: LOOKUP FAILED (${lookup.message}): review`;
    case "value":
      return lookup.value === cell.naive
        ? "      baseline: unchanged since the baseline dump: the UTC reading holds"
        : `      baseline: was ${lookup.value === null ? "empty" : naiveShort(lookup.value)}: changed since, review`;
  }
}

interface AuditRow {
  run_id: string;
  table_name: string;
  row_id: string | null;
  document_id: string | null;
  label: string | null;
  column_name: string;
  old_naive: string;
  zone: string;
  class: string;
}

/** Postgres' text form of a naive timestamp -> 'YYYY-MM-DDTHH:MM:SS[.ffffff]'. */
function auditNaive(text: string): string {
  return text.replace(" ", "T");
}

/**
 * The current value of an audited cell, for every row of its document (the
 * draft and the published row; Strapi re-creates the published row on each
 * publish, so the audited row id may be gone), in APP_TIME_ZONE.
 */
async function currentValues(
  sql: SqlClient,
  mainSchema: SchemaCache,
  options: ReportOptions,
  row: AuditRow,
): Promise<string> {
  const columns = await mainSchema(row.table_name);
  if (!/ with time zone$/.test(columns.get(row.column_name) ?? "")) {
    return `      now: ${row.table_name}.${row.column_name} is not timestamptz, not read`;
  }
  let where: string;
  let bindings: unknown[];
  if (row.document_id !== null && columns.has("document_id")) {
    where = "document_id = ?";
    bindings = [row.document_id];
  } else if (row.row_id !== null && columns.has("id")) {
    where = "id = ?";
    bindings = [Number(row.row_id)];
  } else {
    return "      now: no document id or row id to look the row up by";
  }
  const id = columns.has("id") ? `${quoteIdent("id")}::text` : "NULL::text";
  const draft = columns.has("published_at") ? `${quoteIdent("published_at")} IS NULL` : "NULL::boolean";
  const found = await inSavepoint(sql, () =>
    sql.query<{ id: string | null; draft: boolean | null; v: string | null }>(
      `SELECT ${id} AS id, ${draft} AS draft,
              to_char(${quoteIdent(row.column_name)} AT TIME ZONE ?, 'YYYY-MM-DD HH24:MI:SS') AS v
         FROM ${qualifiedTable(options.schema, row.table_name)}
        WHERE ${where}
        ORDER BY 2 DESC NULLS LAST, 1`,
      [options.appTimeZone, ...bindings],
    ),
  );
  if (found.length === 0) return "      now: gone (deleted since the repair)";
  const state = (value: boolean | null) => (value === true ? "draft" : value === false ? "published" : "row");
  return (
    `      now in ${options.appTimeZone}: ` +
    found.map((current) => `${state(current.draft)} #${current.id ?? "?"} ${current.v ?? "empty"}`).join(", ")
  );
}

/**
 * After the repair: the ambiguous values it recorded in the audit table,
 * named by document and label, with the reading it chose, the other one and
 * the document's current values, for the review in the admin panel
 * (DEPLOYMENT.md, after the deploy). Returns the number of failed lookups.
 */
async function printRecordedAmbiguous(sql: SqlClient, options: ReportOptions, print: Print): Promise<number> {
  const { settings, now } = options;
  const audit = qualifiedTable(options.schema, AUDIT_TABLE);
  const auditColumns = await tableColumnTypes(sql, options.schema, AUDIT_TABLE);
  // An audit table from a rehearsal of an earlier build has no document_id/label.
  const optional = (column: string) => (auditColumns.has(column) ? quoteIdent(column) : `NULL::text AS ${quoteIdent(column)}`);
  const rows = await sql.query<AuditRow>(
    `SELECT run_id, table_name, row_id::text AS row_id, ${optional("document_id")}, ${optional("label")},
            column_name, old_naive, zone, class
       FROM ${audit}
      WHERE class IN ('C', 'C-allday')
      ORDER BY run_id, table_name, row_id, column_name`,
  );
  const zone = settings.zone;
  const listed = rows.filter((row) => {
    if (options.all) return true;
    const readings = [plainDateTimeToInstant(auditNaive(row.old_naive), "UTC")];
    if (zone) readings.push(plainDateTimeToInstant(auditNaive(row.old_naive), zone));
    return readings.some((instant) => instant.getTime() >= now.getTime());
  });
  print();
  print(
    `Ambiguous values the repair recorded in ${AUDIT_TABLE}: ${rows.length}, ` +
      `${options.all ? "all listed" : `${listed.length} still open or upcoming listed (--all for every one)`}:`,
  );
  const mainSchema = schemaCache(sql, options.schema);
  let lookupErrors = 0;
  const printNow = async (row: AuditRow) => {
    try {
      print(await currentValues(sql, mainSchema, options, row));
    } catch (error) {
      lookupErrors += 1;
      print(`      now: LOOKUP FAILED (${(error as Error).message})`);
    }
  };
  for (const row of listed) {
    const naive = auditNaive(row.old_naive);
    print(
      `  ${row.table_name}#${row.row_id ?? "?"}${row.document_id ? ` doc ${row.document_id}` : ""}` +
        `${row.label ? ` "${row.label}"` : ""} ${row.column_name} = ${naiveShort(naive)} ` +
        `[${row.class}, run ${row.run_id}, repaired as ${row.zone}]`,
    );
    print(`      read as UTC:             ${reading(naive, "UTC", options.appTimeZone)} ${options.appTimeZone}`);
    if (zone) {
      print(`      read as ${zone.padEnd(16)} ${reading(naive, zone, options.appTimeZone)} ${options.appTimeZone}`);
    }
    await printNow(row);
  }

  // Event, poll, announcement and release times the repair read in the
  // legacy zone although they fall in a DST change hour: the repair took the
  // standard-time instant; one meant as the first (summer time) occurrence is
  // an hour late now. Listed in full, each needs a look.
  const folds = await sql.query<AuditRow>(
    `SELECT run_id, table_name, row_id::text AS row_id, ${optional("document_id")}, ${optional("label")},
            column_name, old_naive, zone, class
       FROM ${audit}
      WHERE zone <> 'UTC'
      ORDER BY run_id, table_name, row_id, column_name`,
  );
  const enteredFolds = folds.filter(
    (row) =>
      isUserEntered(row.table_name, row.column_name) &&
      wallTimeOccurrence(auditNaive(row.old_naive), row.zone) !== "unique",
  );
  if (enteredFolds.length > 0) {
    print();
    print(
      `Event, poll and announcement times the repair read in a DST change hour: ${enteredFolds.length} ` +
        "(check each in the admin panel; fix the ones meant as the other reading):",
    );
    for (const row of enteredFolds) {
      const naive = auditNaive(row.old_naive);
      print(
        `  ${row.table_name}#${row.row_id ?? "?"}${row.document_id ? ` doc ${row.document_id}` : ""}` +
          `${row.label ? ` "${row.label}"` : ""} ${row.column_name} = ${naiveShort(naive)} ${row.zone} ` +
          `[${row.class}, run ${row.run_id}]`,
      );
      print(`      ${foldReadings(naive, row.zone, options.appTimeZone)}`);
      await printNow(row);
    }
  }
  return lookupErrors;
}

/** Prints the report. Only runs SELECTs (and savepoints) on `sql`, inside its READ ONLY transaction. */
export async function runReport(sql: SqlClient, options: ReportOptions, print: Print): Promise<ReportResult> {
  const { schema, settings, now } = options;
  let lookupErrors = 0;
  const allNaive = await listNaiveColumns(sql, schema);
  const repair = repairColumns(allNaive);
  const recorded = await legacyMigrationRecorded(sql, schema);
  const auditExists = await tableExists(sql, schema, AUDIT_TABLE);

  print(`Datetime repair report (read-only), ${toIsoZ(now)}`);
  print(
    `  schema ${schema} | legacy zone ${settings.zone ?? "(DATETIME_LEGACY_ZONE unset)"} | θ ` +
      `${settings.theta ? `${settings.theta.iso} (stored ${naiveShort(settings.theta.naive)})` : "(unset: whole database legacy)"}` +
      ` | APP_TIME_ZONE ${options.appTimeZone}`,
  );
  print(`  repair recorded in strapi_migrations: ${recorded ? "yes" : "no"}${auditExists ? `, ${AUDIT_TABLE} present` : ""}`);
  print(
    `  naive timestamp columns: ${allNaive.length} (to repair: ${repair.length}; bookkeeping, left to the guard: ` +
      `${allNaive.filter(({ table }) => BOOKKEEPING_TABLES.includes(table)).length})`,
  );

  const plan = await buildLegacyPlan(sql, schema, settings, { now });
  if (repair.length === 0) {
    print();
    print("Nothing to repair: every app column is already timestamptz.");
    if (auditExists) lookupErrors += await printRecordedAmbiguous(sql, options, print);
    return { plan, lookupErrors };
  }
  if (plan.tables.length === 0) {
    print();
    print("The naive columns hold no data: the migration converts them without a rewrite (no env needed).");
    return { plan, lookupErrors };
  }
  if (!settings.zone) {
    print();
    print("DATETIME_LEGACY_ZONE is unset: the migration would REFUSE to start (data present). Set it first.");
  }

  print();
  if (plan.gap) {
    const { gap } = plan;
    print(
      `Gap check: ${gap.ok ? "OK" : "FAILS (the migration would abort)"}. ` +
        `${gap.gapMinutes === null ? "No stamps on one side of θ" : `${gap.gapMinutes.toFixed(1)} min`} between ` +
        `${gap.before ? `${naiveShort(gap.before.naive)} (${gap.before.where})` : "-"} and ` +
        `${gap.after ? `${naiveShort(gap.after.naive)} (${gap.after.where})` : "-"}; needs >= ${gap.requiredMinutes} min.`,
    );
    for (const reason of gapFailureReasons(gap)) print(`  - ${reason}.`);
  } else {
    print("Gap check: skipped (θ unset).");
  }

  print();
  print("Values per table, column and class (legacy classes are rewritten to UTC):");
  const byColumn = new Map<string, string[]>();
  for (const [key, count] of classCounts(plan)) {
    const [column, cls] = key.split(" ");
    byColumn.set(column, [...(byColumn.get(column) ?? []), `${cls}=${count}`]);
  }
  for (const [column, classes] of byColumn) print(`  ${column.padEnd(44)} ${classes.join(" ")}`);

  const ambiguous = plan.tables.flatMap((table) => table.cells).filter((cell) => cell.cls === "C" || cell.cls === "C-allday");
  const listed = options.all ? ambiguous : ambiguous.filter((cell) => isOpen(cell, settings, now));
  print();
  print(
    `Ambiguous values (class C: created before θ, saved again after it): ${ambiguous.length}, ` +
      `${options.all ? "all listed" : `${listed.length} still open or upcoming listed (--all for every one)`}:`,
  );
  const mainSchema = schemaCache(sql, schema);
  const baselineSchema = options.baseline ? schemaCache(options.baseline.sql, options.baseline.schema) : null;
  for (const cell of listed) {
    const chosen = cell.legacy ? `read as ${settings.zone}` : "read as UTC";
    print(
      `  ${cell.table}#${cell.key}${cell.documentId ? ` doc ${cell.documentId}` : ""}` +
        `${cell.label ? ` "${cell.label}"` : ""} ${cell.column} = ${naiveShort(cell.naive)} [${cell.cls}, migration: ${chosen}]`,
    );
    print(`      read as UTC:             ${reading(cell.naive, "UTC", options.appTimeZone)} ${options.appTimeZone}`);
    if (settings.zone) {
      print(`      read as ${settings.zone.padEnd(16)} ${reading(cell.naive, settings.zone, options.appTimeZone)} ${options.appTimeZone}`);
    }
    if (options.baseline && baselineSchema) {
      let lookup: BaselineLookup;
      try {
        const draft = await isDraftRow(sql, mainSchema, schema, cell);
        lookup = await baselineValue(options.baseline, baselineSchema, cell, draft);
      } catch (error) {
        lookup = { kind: "error", message: (error as Error).message };
      }
      if (lookup.kind === "error") lookupErrors += 1;
      print(describeBaseline(lookup, cell));
    }
  }
  if (lookupErrors > 0) {
    print();
    print(`${lookupErrors} baseline lookup(s) FAILED (see LOOKUP FAILED above): those values are not compared.`);
  }

  const folds = plan.tables.flatMap((table) => table.cells).filter((cell) => cell.ambiguous);
  if (folds.length > 0 && settings.zone) {
    const entered = folds.filter((cell) => cell.kind === "user");
    const stamps = folds.filter((cell) => cell.kind !== "user");
    print();
    print(
      `Legacy-zone values in a DST change hour (read as standard time): ${folds.length}, ` +
        `${entered.length} of them event, poll or announcement times (check each after the repair):`,
    );
    for (const cell of entered) {
      print(
        `  ${cell.table}#${cell.key}${cell.documentId ? ` doc ${cell.documentId}` : ""}` +
          `${cell.label ? ` "${cell.label}"` : ""} ${cell.column} = ${naiveShort(cell.naive)} [${cell.cls}]`,
      );
      print(`      ${foldReadings(cell.naive, settings.zone, options.appTimeZone)}`);
    }
    for (const cell of stamps.slice(0, 50)) print(`  ${cell.table}.${cell.column}#${cell.key} = ${naiveShort(cell.naive)}`);
    if (stamps.length > 50) print(`  … and ${stamps.length - 50} more write stamps`);
  }

  if (options.around) await printAround(print, plan, options.around);
  return { plan, lookupErrors };
}

interface CliArgs {
  [flag: string]: string | boolean | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument "${flag}"`);
    const name = flag.slice(2);
    if (name === "all" || name === "help") {
      args[name] = true;
    } else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      args[name] = value;
      index += 1;
    }
  }
  return args;
}

interface PgClient extends PgQueryable {
  connect(): Promise<void>;
  end(): Promise<void>;
}

export type PgClientCtor = new (config: Record<string, unknown>) => PgClient;

export interface ReadOnlySession {
  sql: SqlClient;
  /** Rolls the transaction back and disconnects. */
  close(): Promise<void>;
}

/** Connects and opens the READ ONLY transaction every report query runs in. */
export async function openReadOnlySession(Client: PgClientCtor, config: Record<string, unknown>): Promise<ReadOnlySession> {
  const client = new Client(config);
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
  } catch (error) {
    await client.end();
    throw error;
  }
  return {
    sql: pgSqlClient(client),
    async close() {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    },
  };
}

/** Read-only pg connection settings for the cms database or a given URL. */
export function connectionConfig(env: Record<string, string | undefined>, url?: string): Record<string, unknown> {
  const readOnly = { options: "-c TimeZone=UTC -c default_transaction_read_only=on" };
  const ssl =
    env.DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" } } : {};
  if (url) return { connectionString: url, ...readOnly };
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ...ssl, ...readOnly };
  return {
    host: env.DATABASE_HOST ?? "localhost",
    port: Number(env.DATABASE_PORT ?? 5432),
    database: env.DATABASE_NAME ?? "sinnlos",
    user: env.DATABASE_USERNAME ?? "sinnlos",
    password: env.DATABASE_PASSWORD,
    ...ssl,
    ...readOnly,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "node dist/scripts/datetime-migration-report.js [--url <postgres-url>] [--schema <name>] " +
        "[--legacy-zone <IANA>] [--utc-until <ISO>] [--around <ISO>] [--all] [--baseline <postgres-url> " +
        "[--baseline-schema <name>]] [--now <ISO>]\n",
    );
    return;
  }
  const env = process.env;
  const str = (name: string): string | undefined => (typeof args[name] === "string" ? (args[name] as string) : undefined);
  const settings = readLegacySettings({
    DATETIME_LEGACY_ZONE: str("legacy-zone") ?? env.DATETIME_LEGACY_ZONE,
    DATETIME_LEGACY_UTC_UNTIL: str("utc-until") ?? env.DATETIME_LEGACY_UTC_UNTIL,
  });
  const nowArg = str("now");
  const nowMs = nowArg === undefined ? Date.now() : instantMsOrNull(nowArg);
  if (nowMs === null) throw new Error(`--now needs an ISO instant with an offset, got "${nowArg}"`);

  const { Client } = pgModule as unknown as { Client: PgClientCtor };
  const sessions: ReadOnlySession[] = [];
  const open = async (config: Record<string, unknown>): Promise<SqlClient> => {
    const session = await openReadOnlySession(Client, config);
    sessions.push(session);
    return session.sql;
  };
  try {
    const sql = await open(connectionConfig(env, str("url")));
    const baselineUrl = str("baseline");
    const baseline = baselineUrl
      ? { sql: await open(connectionConfig(env, baselineUrl)), schema: str("baseline-schema") ?? "public" }
      : undefined;
    const { lookupErrors } = await runReport(
      sql,
      {
        schema: str("schema") ?? env.DATABASE_SCHEMA ?? "public",
        settings,
        appTimeZone: appTimeZone(env),
        now: new Date(nowMs),
        around: str("around"),
        all: args.all === true,
        baseline,
      },
      (line = "") => process.stdout.write(`${line}\n`),
    );
    if (lookupErrors > 0) {
      process.stderr.write(`datetime-migration-report: ${lookupErrors} lookup(s) failed, see LOOKUP FAILED above\n`);
      process.exitCode = 1;
    }
  } finally {
    for (const session of sessions) await session.close();
  }
}

// Run as a script (node dist/scripts/...), not when imported by a test.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`datetime-migration-report: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
