/**
 * READ-ONLY report for the one-time datetime repair (datetime contract,
 * deep-dive decision 04, C11). It shows what the user migration
 * database/migrations/2026.10.05T00.00.00.datetime-timestamptz.js would do,
 * with the same rules (src/database/datetime-legacy.ts), and changes nothing:
 * the session runs with default_transaction_read_only=on inside a
 * READ ONLY transaction that is rolled back.
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
  tableExists,
  type PgQueryable,
  type SqlClient,
} from "../src/database/datetime-catalog";
import {
  buildLegacyPlan,
  classCounts,
  readLegacySettings,
  repairColumns,
  type CellPlan,
  type LegacyPlan,
  type LegacySettings,
} from "../src/database/datetime-legacy";
import { appTimeZone, formatInstant, instantMsOrNull, plainDateTimeToInstant, toIsoZ } from "../src/utils/time";

export interface ReportOptions {
  schema: string;
  settings: LegacySettings;
  appTimeZone: string;
  now: Date;
  around?: string;
  all?: boolean;
  baseline?: { sql: SqlClient; schema: string };
}

type Print = (line?: string) => void;

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

function reading(naive: string, zone: string, appZone: string): string {
  const instant = plainDateTimeToInstant(naive, zone);
  return formatInstant(
    "sv-SE",
    instant,
    { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" },
    appZone,
  );
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

async function baselineValue(
  baseline: NonNullable<ReportOptions["baseline"]>,
  cell: CellPlan,
  draft: boolean | null,
): Promise<string | null | undefined> {
  const table = qualifiedTable(baseline.schema, cell.table);
  const value = `to_char(${quoteIdent(cell.column)}, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS v`;
  try {
    if (cell.documentId !== null && draft !== null) {
      const found = await baseline.sql.query<{ v: string | null }>(
        `SELECT ${value} FROM ${table} WHERE document_id = ? AND (published_at IS NULL) = ? LIMIT 1`,
        [cell.documentId, draft],
      );
      return found.length === 0 ? undefined : found[0].v;
    }
    if (cell.rowId !== null) {
      const found = await baseline.sql.query<{ v: string | null }>(`SELECT ${value} FROM ${table} WHERE id = ?`, [
        cell.rowId,
      ]);
      return found.length === 0 ? undefined : found[0].v;
    }
  } catch {
    // Older schema without this table or column.
  }
  return undefined;
}

async function isDraftRow(sql: SqlClient, schema: string, cell: CellPlan): Promise<boolean | null> {
  if (cell.rowId === null) return null;
  try {
    const [row] = await sql.query<{ draft: boolean }>(
      `SELECT published_at IS NULL AS draft FROM ${qualifiedTable(schema, cell.table)} WHERE id = ?`,
      [cell.rowId],
    );
    return row ? row.draft : null;
  } catch {
    return null;
  }
}

/** Prints the report. Only runs SELECTs on `sql`. */
export async function runReport(sql: SqlClient, options: ReportOptions, print: Print): Promise<LegacyPlan> {
  const { schema, settings, now } = options;
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

  const plan = await buildLegacyPlan(sql, schema, settings);
  if (repair.length === 0) {
    print();
    print("Nothing to repair: every app column is already timestamptz.");
    return plan;
  }
  if (plan.tables.length === 0) {
    print();
    print("The naive columns hold no data: the migration converts them without a rewrite (no env needed).");
    return plan;
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
  for (const cell of listed) {
    const draft = options.baseline ? await isDraftRow(sql, schema, cell) : null;
    const chosen = cell.legacy ? `read as ${settings.zone}` : "read as UTC";
    print(
      `  ${cell.table}#${cell.key}${cell.documentId ? ` doc ${cell.documentId}` : ""}` +
        `${cell.label ? ` "${cell.label}"` : ""} ${cell.column} = ${naiveShort(cell.naive)} [${cell.cls}, migration: ${chosen}]`,
    );
    print(`      read as UTC:             ${reading(cell.naive, "UTC", options.appTimeZone)} ${options.appTimeZone}`);
    if (settings.zone) {
      print(`      read as ${settings.zone.padEnd(16)} ${reading(cell.naive, settings.zone, options.appTimeZone)} ${options.appTimeZone}`);
    }
    if (options.baseline) {
      const before = await baselineValue(options.baseline, cell, draft);
      print(
        before === undefined
          ? "      baseline: not in the baseline dump (created later): review"
          : before === cell.naive
            ? "      baseline: unchanged since the baseline dump: the UTC reading holds"
            : `      baseline: was ${before === null ? "empty" : naiveShort(before)}: changed since, review`,
      );
    }
  }

  const folds = plan.tables.flatMap((table) => table.cells).filter((cell) => cell.ambiguous);
  if (folds.length > 0) {
    print();
    print(`Legacy-zone values in a DST change hour (read as standard time): ${folds.length}`);
    for (const cell of folds.slice(0, 50)) print(`  ${cell.table}.${cell.column}#${cell.key} = ${naiveShort(cell.naive)}`);
  }

  if (options.around) await printAround(print, plan, options.around);
  return plan;
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

type PgClientCtor = new (config: Record<string, unknown>) => PgClient;

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
  const clients: PgClient[] = [];
  const open = async (config: Record<string, unknown>): Promise<SqlClient> => {
    const client = new Client(config);
    await client.connect();
    clients.push(client);
    await client.query("BEGIN READ ONLY");
    return pgSqlClient(client);
  };
  try {
    const sql = await open(connectionConfig(env, str("url")));
    const baselineUrl = str("baseline");
    const baseline = baselineUrl
      ? { sql: await open(connectionConfig(env, baselineUrl)), schema: str("baseline-schema") ?? "public" }
      : undefined;
    await runReport(
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
  } finally {
    for (const client of clients) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  }
}

// Run as a script (node dist/scripts/...), not when imported by a test.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`datetime-migration-report: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
