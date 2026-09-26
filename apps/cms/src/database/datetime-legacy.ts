/**
 * One-time repair of legacy datetime values (datetime contract, deep-dive
 * decision 04, C11), used by the user migration
 * database/migrations/2026.10.05T00.00.00.datetime-timestamptz.js and, read
 * only, by the report CLI scripts/datetime-migration-report.ts.
 *
 * The problem: before this release every instant sat in a
 * `timestamp without time zone` column as the wall clock of the WRITING cms
 * process. A database written by a cms in UTC holds UTC wall clocks; one
 * written in Europe/Berlin holds Berlin wall clocks; the owner's database
 * holds both (UTC before the 2026-08-15 TZ switch, Berlin after it). The
 * recurring guard (ensure-timestamptz.ts) reads a naive value as UTC, so
 * every legacy-zone value has to be rewritten to its UTC wall clock first,
 * once, in the same transaction that converts the column to timestamptz.
 *
 * Configuration (env; a fresh install sets neither):
 *  - DATETIME_LEGACY_ZONE: the zone the legacy cms ran in (owner:
 *    Europe/Berlin). Required when a naive column holds data.
 *  - DATETIME_LEGACY_UTC_UNTIL: optional ISO instant with an offset (θ).
 *    Values stamped before θ are UTC wall clocks, values after it are in
 *    the legacy zone. Unset: the whole database is in the legacy zone.
 *
 * Classification per cell (all comparisons in naive wall-clock terms):
 *  - write-time stamps (the default: created_at, updated_at, published_at,
 *    read_at, responded_at, ...): by their own value, < θ is UTC;
 *  - expires_at/absolute_expires_at on session and token tables: by the
 *    row's created_at (written in the same process zone);
 *  - user-entered instants (events.start/end, polls.closes_at,
 *    announcements.expires_at, strapi_releases.scheduled_at):
 *      A  the document (all its draft/publish rows) was created after θ:
 *         legacy zone;
 *      B  the row was last updated before θ: UTC;
 *      C  otherwise (created before, re-saved after): ambiguous. UTC by
 *         default, except an all-day event whose legacy reading is a local
 *         midnight (then the legacy zone). The report CLI lists open class-C
 *         rows with both readings.
 *  - `date` columns are not touched (they are not naive timestamps);
 *    Strapi's bookkeeping tables are left to the guard.
 *
 * Safety: a gap check proves θ sits in the empty stretch the switch left in
 * the write stamps (see checkGap), an audit table keeps every old value as
 * text, and the whole repair runs in the migration's single transaction.
 */
import { canonicalTimeZone } from "../utils/plain-date";
import {
  isUtcZone,
  offsetMinutesAt,
  processTimeZone,
  toInstant,
  toIsoZ,
  wallTimeOccurrence,
} from "../utils/time";
import {
  AUDIT_TABLE,
  BOOKKEEPING_TABLES,
  LEGACY_MIGRATION_NAME,
  alterToTimestamptzSql,
  columnsHoldValues,
  groupByTable,
  knexSqlClient,
  listNaiveColumns,
  pgArrayLiteral,
  qualifiedTable,
  quoteIdent,
  tableColumnTypes,
  type KnexRawLike,
  type NaiveColumn,
  type SqlClient,
} from "./datetime-catalog";

export { LEGACY_MIGRATION_NAME };

/** User-entered instants: their value tells nothing about the writer's zone. */
export const USER_ENTERED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  events: ["start", "end"],
  polls: ["closes_at"],
  announcements: ["expires_at"],
  strapi_releases: ["scheduled_at"],
};

const EXPIRY_COLUMNS = new Set(["expires_at", "absolute_expires_at"]);
const SESSION_OR_TOKEN_TABLE = /(session|token)/i;

/** Human label per table for the report (first column that exists). */
const LABEL_COLUMNS = ["title", "question", "name"];

/** 'YYYY-MM-DDTHH:MM:SS.ffffff', the one naive format the repair compares. */
const NAIVE_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;
const NAIVE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export type ColumnKind = "write" | "expiry" | "user";

export type CellClass =
  | "write-utc"
  | "write-legacy"
  | "expiry-utc"
  | "expiry-legacy"
  | "A"
  | "B"
  | "C"
  | "C-allday"
  | "legacy-all"
  | "unreadable";

export interface LegacySettings {
  /** DATETIME_LEGACY_ZONE (canonical), or null when unset. */
  zone: string | null;
  /** θ from DATETIME_LEGACY_UTC_UNTIL, or null (whole database in the legacy zone). */
  theta: { iso: string; naive: string } | null;
}

export const MISSING_LEGACY_ZONE_MESSAGE =
  "[datetime] This database holds datetime values written before the datetime contract " +
  "(naive `timestamp without time zone` columns with data). Set DATETIME_LEGACY_ZONE " +
  "(the zone the old cms ran in, e.g. Europe/Berlin) and, if the old cms ran in UTC for a " +
  "while first, DATETIME_LEGACY_UTC_UNTIL (the switch instant, ISO with offset). Inspect the " +
  "data first with the read-only report: node dist/scripts/datetime-migration-report.js " +
  '(docs/DEPLOYMENT.md "Datetime contract"). Nothing was changed.';

/** An instant as its naive UTC wall clock in NAIVE format. */
export function naiveUtcOf(iso: string): string {
  return `${toIsoZ(iso).slice(0, 23)}000`;
}

/** Validates the two legacy env vars; throws with the variable's name. */
export function readLegacySettings(env: Record<string, string | undefined>): LegacySettings {
  const rawZone = env.DATETIME_LEGACY_ZONE?.trim();
  const rawUntil = env.DATETIME_LEGACY_UTC_UNTIL?.trim();
  let zone: string | null = null;
  if (rawZone) {
    zone = canonicalTimeZone(rawZone);
    if (!zone) {
      throw new Error(
        "DATETIME_LEGACY_ZONE must be an IANA time zone name such as Europe/Berlin, not a UTC offset " +
          `(Postgres reads '+02:00' as UTC-2): "${rawZone}"`,
      );
    }
  }
  let theta: LegacySettings["theta"] = null;
  if (rawUntil) {
    if (!zone) throw new Error("DATETIME_LEGACY_UTC_UNTIL needs DATETIME_LEGACY_ZONE as well");
    let iso: string;
    try {
      iso = toIsoZ(toInstant(rawUntil));
    } catch {
      throw new Error(
        `DATETIME_LEGACY_UTC_UNTIL must be an ISO-8601 instant with Z or an offset, e.g. ` +
          `2026-08-15T21:46:42+02:00 (got "${rawUntil}")`,
      );
    }
    theta = { iso, naive: naiveUtcOf(iso) };
  }
  return { zone, theta };
}

/** How a column's values are classified. */
export function columnKind(table: string, column: string, tableColumns: ReadonlySet<string>): ColumnKind {
  if (USER_ENTERED_COLUMNS[table]?.includes(column)) return "user";
  if (EXPIRY_COLUMNS.has(column) && SESSION_OR_TOKEN_TABLE.test(table) && tableColumns.has("created_at")) {
    return "expiry";
  }
  return "write";
}

export interface CellInput {
  kind: ColumnKind;
  /** The cell, NAIVE format. */
  naive: string;
  /** The row's created_at / updated_at, NAIVE format (null if absent). */
  rowCreatedAt: string | null;
  rowUpdatedAt: string | null;
  /** Earliest created_at over the rows of the same document (null if unknown). */
  documentCreatedAt: string | null;
  /** events.all_day of the row. */
  allDay: boolean;
}

export interface CellDecision {
  cls: CellClass;
  /** True: the value is a legacy-zone wall clock and gets rewritten to UTC. */
  legacy: boolean;
}

/** The per-cell rule table (see the module comment). Pure. */
export function classifyCell(cell: CellInput, settings: LegacySettings): CellDecision {
  if (!NAIVE_RE.test(cell.naive)) return { cls: "unreadable", legacy: false };
  if (!settings.theta) return { cls: "legacy-all", legacy: true };
  const theta = settings.theta.naive;
  if (cell.kind === "write") {
    return cell.naive < theta ? { cls: "write-utc", legacy: false } : { cls: "write-legacy", legacy: true };
  }
  if (cell.kind === "expiry") {
    const reference = cell.rowCreatedAt ?? cell.naive;
    return reference < theta ? { cls: "expiry-utc", legacy: false } : { cls: "expiry-legacy", legacy: true };
  }
  const created = cell.documentCreatedAt ?? cell.rowCreatedAt;
  if (created !== null && created >= theta) return { cls: "A", legacy: true };
  if (cell.rowUpdatedAt !== null && cell.rowUpdatedAt < theta) return { cls: "B", legacy: false };
  if (cell.allDay && cell.naive.slice(11) === "00:00:00.000000") return { cls: "C-allday", legacy: true };
  return { cls: "C", legacy: false };
}

/** A naive NAIVE-format wall clock as epoch ms, read as UTC (for differences only). */
function naiveMs(naive: string): number {
  return Date.parse(`${naive.slice(0, 23)}Z`);
}

export interface WriteStamp {
  naive: string;
  /** table.column#row for messages. */
  where: string;
}

export interface GapCheck {
  theta: string;
  /** The last write stamp before θ and the first at or after it (naive). */
  before: WriteStamp | null;
  after: WriteStamp | null;
  gapMinutes: number | null;
  /** The legacy zone's UTC offset at θ: the minimum empty stretch around θ. */
  requiredMinutes: number;
  ok: boolean;
}

/**
 * θ must sit inside an empty stretch of the write-time stamps at least as
 * long as the legacy zone's offset at θ. The switch from a UTC writer to a
 * legacy-zone writer at instant T leaves exactly such a stretch: stamps
 * before T are < T, stamps after it are >= T + offset. Any θ in that
 * stretch classifies every write stamp correctly; a θ outside it would
 * misclassify the stamps between θ and the stretch, and then the stretch
 * around θ is shorter than the offset (unless activity paused for longer,
 * which is why θ comes from the pre-deploy backup time and the report
 * shows the neighbourhood).
 */
export function checkGap(stamps: readonly WriteStamp[], settings: LegacySettings): GapCheck | null {
  if (!settings.theta || !settings.zone) return null;
  const theta = settings.theta.naive;
  let before: WriteStamp | null = null;
  let after: WriteStamp | null = null;
  for (const stamp of stamps) {
    if (!NAIVE_RE.test(stamp.naive)) continue;
    if (stamp.naive < theta) {
      if (!before || stamp.naive > before.naive) before = stamp;
    } else if (!after || stamp.naive < after.naive) {
      after = stamp;
    }
  }
  const requiredMinutes = offsetMinutesAt(settings.theta.iso, settings.zone);
  const gapMinutes = before && after ? (naiveMs(after.naive) - naiveMs(before.naive)) / 60000 : null;
  return {
    theta,
    before,
    after,
    gapMinutes,
    requiredMinutes,
    ok: gapMinutes === null || gapMinutes >= requiredMinutes,
  };
}

export interface CellPlan {
  table: string;
  column: string;
  kind: ColumnKind;
  /** Row address: the id, or the ctid for a table without an id column. */
  key: string;
  rowId: number | null;
  documentId: string | null;
  label: string | null;
  /** The value in NAIVE format and as Postgres prints it (for the audit). */
  naive: string;
  text: string;
  cls: CellClass;
  legacy: boolean;
  /** Legacy wall time that is repeated or skipped in the legacy zone. */
  ambiguous: boolean;
}

export interface TablePlan {
  table: string;
  columns: string[];
  kinds: Record<string, ColumnKind>;
  keyColumn: "id" | "ctid";
  cells: CellPlan[];
}

export interface LegacyPlan {
  schema: string;
  settings: LegacySettings;
  /** Tables whose naive columns hold data, with every non-null cell. */
  tables: TablePlan[];
  /** Tables whose naive columns are all empty (converted without a rewrite). */
  emptyTables: { table: string; columns: string[] }[];
  gap: GapCheck | null;
  writeStamps: WriteStamp[];
}

/** Naive columns the repair owns: the schema's, minus bookkeeping and audit. */
export function repairColumns(columns: readonly NaiveColumn[]): NaiveColumn[] {
  return columns.filter(({ table }) => !BOOKKEEPING_TABLES.includes(table) && table !== AUDIT_TABLE);
}

interface SnapshotRow {
  row_key: string;
  row_id: number | string | null;
  document_id: string | null;
  created_at_n: string | null;
  updated_at_n: string | null;
  all_day: boolean | null;
  label: string | null;
  [cell: string]: unknown;
}

/**
 * Reads every table with naive columns and classifies each non-null cell.
 * Read-only unless `lock` is set (the migration locks each table against
 * writers first, so the rows it classifies are the rows it rewrites).
 */
export async function buildLegacyPlan(
  sql: SqlClient,
  schema: string,
  settings: LegacySettings,
  options: { lock?: boolean } = {},
): Promise<LegacyPlan> {
  const byTable = groupByTable(repairColumns(await listNaiveColumns(sql, schema)));
  const tables: TablePlan[] = [];
  const emptyTables: LegacyPlan["emptyTables"] = [];
  const writeStamps: WriteStamp[] = [];

  for (const [table, columns] of byTable) {
    if (options.lock) {
      await sql.query(`LOCK TABLE ${qualifiedTable(schema, table)} IN SHARE ROW EXCLUSIVE MODE`);
    }
    if (!(await columnsHoldValues(sql, schema, table, columns))) {
      emptyTables.push({ table, columns });
      continue;
    }
    const types = await tableColumnTypes(sql, schema, table);
    const has = (column: string) => types.has(column);
    const keyColumn: TablePlan["keyColumn"] = /^(integer|bigint|smallint)$/.test(types.get("id") ?? "")
      ? "id"
      : "ctid";
    const naiveOf = (column: string) => `to_char(${quoteIdent(column)}, ${NAIVE_FORMAT})`;
    const labelColumn = LABEL_COLUMNS.find(has);
    const select = [
      `${keyColumn === "id" ? quoteIdent("id") : "ctid"}::text AS row_key`,
      keyColumn === "id" ? `${quoteIdent("id")} AS row_id` : "NULL::bigint AS row_id",
      has("document_id") ? `${quoteIdent("document_id")}::text AS document_id` : "NULL::text AS document_id",
      has("created_at") ? `${naiveOf("created_at")} AS created_at_n` : "NULL::text AS created_at_n",
      has("updated_at") ? `${naiveOf("updated_at")} AS updated_at_n` : "NULL::text AS updated_at_n",
      has("all_day") ? `${quoteIdent("all_day")} AS all_day` : "NULL::boolean AS all_day",
      labelColumn ? `left(${quoteIdent(labelColumn)}::text, 80) AS label` : "NULL::text AS label",
      ...columns.flatMap((column, index) => [
        `${naiveOf(column)} AS ${quoteIdent(`n${index}`)}`,
        `${quoteIdent(column)}::text AS ${quoteIdent(`t${index}`)}`,
      ]),
    ];
    const rows = await sql.query<SnapshotRow>(
      `SELECT ${select.join(", ")} FROM ${qualifiedTable(schema, table)} ORDER BY 1`,
    );

    // Earliest created_at per document, over all its draft/publish rows.
    const documentCreated = new Map<string, string>();
    for (const row of rows) {
      if (!row.document_id || !row.created_at_n) continue;
      const known = documentCreated.get(row.document_id);
      if (!known || row.created_at_n < known) documentCreated.set(row.document_id, row.created_at_n);
    }

    const columnNames = new Set(types.keys());
    const kinds: Record<string, ColumnKind> = {};
    for (const column of columns) kinds[column] = columnKind(table, column, columnNames);

    const cells: CellPlan[] = [];
    for (const row of rows) {
      columns.forEach((column, index) => {
        const naive = row[`n${index}`];
        const text = row[`t${index}`];
        if (typeof naive !== "string" || typeof text !== "string") return;
        const kind = kinds[column];
        const decision = classifyCell(
          {
            kind,
            naive,
            rowCreatedAt: row.created_at_n,
            rowUpdatedAt: row.updated_at_n,
            documentCreatedAt: row.document_id ? (documentCreated.get(row.document_id) ?? null) : null,
            allDay: row.all_day === true,
          },
          settings,
        );
        const ambiguous =
          decision.legacy &&
          settings.zone !== null &&
          wallTimeOccurrence(naive, settings.zone) !== "unique";
        cells.push({
          table,
          column,
          kind,
          key: row.row_key,
          rowId: row.row_id === null ? null : Number(row.row_id),
          documentId: row.document_id,
          label: row.label,
          naive,
          text,
          cls: decision.cls,
          legacy: decision.legacy,
          ambiguous,
        });
        if (kind === "write") writeStamps.push({ naive, where: `${table}.${column}#${row.row_key}` });
      });
    }
    tables.push({ table, columns, kinds, keyColumn, cells });
  }

  return { schema, settings, tables, emptyTables, gap: checkGap(writeStamps, settings), writeStamps };
}

export interface ApplySummary {
  runId: string;
  convertedColumns: number;
  shiftedCells: number;
  auditedCells: number;
}

const AUDIT_BATCH = 500;

async function ensureAuditTable(sql: SqlClient, schema: string): Promise<void> {
  await sql.query(
    `CREATE TABLE IF NOT EXISTS ${qualifiedTable(schema, AUDIT_TABLE)} (
       id bigserial PRIMARY KEY,
       run_id text NOT NULL,
       table_name text NOT NULL,
       row_id bigint,
       row_key text NOT NULL,
       column_name text NOT NULL,
       old_naive text NOT NULL,
       zone text NOT NULL,
       class text NOT NULL,
       migrated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/**
 * Writes the plan: audit rows for every classified cell, one UPDATE per
 * table rewriting the legacy-zone cells to their UTC wall clock (all SET
 * expressions read the old row), then the ALTER to timestamptz(6) of every
 * repaired column. Must run in one transaction with the plan's locks.
 */
export async function applyLegacyPlan(sql: SqlClient, plan: LegacyPlan, runId: string): Promise<ApplySummary> {
  const { schema, settings } = plan;
  let convertedColumns = 0;
  let shiftedCells = 0;
  let auditedCells = 0;

  if (plan.tables.length > 0) await ensureAuditTable(sql, schema);

  for (const tablePlan of plan.tables) {
    const { table, columns, keyColumn, cells } = tablePlan;

    for (let start = 0; start < cells.length; start += AUDIT_BATCH) {
      const batch = cells.slice(start, start + AUDIT_BATCH);
      const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const bindings = batch.flatMap((cell) => [
        runId,
        table,
        cell.rowId,
        cell.key,
        cell.column,
        cell.text,
        cell.legacy ? (settings.zone ?? "UTC") : "UTC",
        cell.cls,
      ]);
      await sql.query(
        `INSERT INTO ${qualifiedTable(schema, AUDIT_TABLE)}
           (run_id, table_name, row_id, row_key, column_name, old_naive, zone, class)
         VALUES ${values}`,
        bindings,
      );
      auditedCells += batch.length;
    }

    const legacyCells = cells.filter((cell) => cell.legacy);
    if (legacyCells.length > 0 && settings.zone) {
      const keyExpr = keyColumn === "id" ? quoteIdent("id") : "ctid";
      const keyType = keyColumn === "id" ? "bigint" : "tid";
      const keysOf = (subset: readonly CellPlan[]) =>
        pgArrayLiteral(keyColumn === "id" ? subset.map((cell) => Number(cell.key)) : subset.map((cell) => cell.key));
      const assignments: string[] = [];
      const bindings: unknown[] = [];
      for (const column of columns) {
        const columnCells = legacyCells.filter((cell) => cell.column === column);
        if (columnCells.length === 0) continue;
        const quoted = quoteIdent(column);
        assignments.push(
          `${quoted} = CASE WHEN ${keyExpr} = ANY(?::${keyType}[]) ` +
            `THEN (${quoted} AT TIME ZONE ?) AT TIME ZONE 'UTC' ELSE ${quoted} END`,
        );
        bindings.push(keysOf(columnCells), settings.zone);
      }
      bindings.push(keysOf(legacyCells));
      await sql.query(
        `UPDATE ${qualifiedTable(schema, table)} SET ${assignments.join(", ")} ` +
          `WHERE ${keyExpr} = ANY(?::${keyType}[])`,
        bindings,
      );
      shiftedCells += legacyCells.length;
    }

    await sql.query(alterToTimestamptzSql(schema, table, columns));
    convertedColumns += columns.length;
  }

  for (const { table, columns } of plan.emptyTables) {
    await sql.query(alterToTimestamptzSql(schema, table, columns));
    convertedColumns += columns.length;
  }

  return { runId, convertedColumns, shiftedCells, auditedCells };
}

/** Counts of cells per table, column and class, for logs and the report. */
export function classCounts(plan: LegacyPlan): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tablePlan of plan.tables) {
    for (const cell of tablePlan.cells) {
      const key = `${cell.table}.${cell.column} ${cell.cls}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function gapFailureMessage(gap: GapCheck): string {
  return (
    `[datetime] DATETIME_LEGACY_UTC_UNTIL (θ = ${gap.theta} UTC) is not inside an empty stretch of ` +
    `write-time stamps of at least ${gap.requiredMinutes} minutes: the last stamp before θ is ` +
    `${gap.before?.naive ?? "none"} (${gap.before?.where ?? "-"}), the first at or after it is ` +
    `${gap.after?.naive ?? "none"} (${gap.after?.where ?? "-"}), ${gap.gapMinutes?.toFixed(1) ?? "-"} minutes ` +
    "apart. A θ there would misclassify stamps. Locate the switch with the report CLI " +
    "(--around <pre-deploy backup time>) and pick θ inside the gap. Nothing was changed."
  );
}

export interface MigrationDb {
  dialect: { client: string };
  getSchemaName(): string | undefined | null;
}

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * The user migration's body: runs inside Strapi's migration transaction
 * (@strapi/database 5.55.1 migrations/common.js:3-5), before the internal
 * migrations and before schema sync (migrations/index.js:21-27,
 * schema/index.js:73-78), i.e. before anything else writes in this boot.
 * Throwing rolls everything back and stops the boot.
 */
export async function runLegacyDatetimeMigration(
  trx: KnexRawLike,
  db: MigrationDb,
  options: {
    env?: Record<string, string | undefined>;
    log?: MigrationLogger;
    now?: Date;
    /** Process zone override for tests (default: this process's zone). */
    processZone?: string;
  } = {},
): Promise<ApplySummary | null> {
  const log = options.log ?? console;
  if (db.dialect.client !== "postgres") {
    log.info("[datetime] legacy repair: not Postgres, nothing to do");
    return null;
  }
  const schema = db.getSchemaName() || "public";
  const sql = knexSqlClient(trx);

  const zone = options.processZone ?? processTimeZone();
  if (!isUtcZone(zone)) {
    throw new Error(
      `[datetime] The datetime migration boot needs a UTC process (TZ=UTC); this process runs in ${zone}. ` +
        "Nothing was changed.",
    );
  }
  const [session] = await sql.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
  if (!isUtcZone(session?.tz)) {
    throw new Error(`[datetime] The database session runs in ${session?.tz}, not UTC. Nothing was changed.`);
  }
  // Bounded waits: a lock held elsewhere fails the boot (and the next boot
  // retries) instead of hanging it.
  await sql.query("SET LOCAL lock_timeout = '30s'");
  await sql.query("SET LOCAL statement_timeout = '15min'");

  const columns = repairColumns(await listNaiveColumns(sql, schema));
  if (columns.length === 0) {
    log.info("[datetime] legacy repair: no naive timestamp columns, nothing to do");
    return null;
  }

  const byTable = groupByTable(columns);
  let holdsData = false;
  for (const [table, tableColumns] of byTable) {
    if (await columnsHoldValues(sql, schema, table, tableColumns)) {
      holdsData = true;
      break;
    }
  }

  const runId = toIsoZ(options.now ?? new Date());
  if (!holdsData) {
    // Fresh or empty database: nothing to interpret, convert as is.
    for (const [table, tableColumns] of byTable) {
      await sql.query(alterToTimestamptzSql(schema, table, tableColumns));
    }
    log.info(`[datetime] legacy repair: ${columns.length} empty naive column(s) converted to timestamptz`);
    return { runId, convertedColumns: columns.length, shiftedCells: 0, auditedCells: 0 };
  }

  const settings = readLegacySettings(options.env ?? process.env);
  if (!settings.zone) throw new Error(MISSING_LEGACY_ZONE_MESSAGE);

  const plan = await buildLegacyPlan(sql, schema, settings, { lock: true });
  if (plan.gap && !plan.gap.ok) throw new Error(gapFailureMessage(plan.gap));

  const ambiguous = plan.tables.flatMap((tablePlan) => tablePlan.cells.filter((cell) => cell.ambiguous));
  if (ambiguous.length > 0) {
    log.warn(
      `[datetime] legacy repair: ${ambiguous.length} legacy-zone value(s) fall in a DST change hour of ` +
        `${settings.zone} and are read as standard time (Postgres AT TIME ZONE); first: ` +
        ambiguous
          .slice(0, 5)
          .map((cell) => `${cell.table}.${cell.column}#${cell.key}=${cell.naive}`)
          .join(", "),
    );
  }

  const summary = await applyLegacyPlan(sql, plan, runId);
  const counts = [...classCounts(plan)].map(([key, count]) => `${key}=${count}`).join(", ");
  log.info(
    `[datetime] legacy repair (run ${runId}, legacy zone ${settings.zone}, ` +
      `θ ${settings.theta?.iso ?? "unset: whole database legacy"}): ${summary.shiftedCells} value(s) rewritten, ` +
      `${summary.convertedColumns} column(s) converted to timestamptz, ${summary.auditedCells} old value(s) ` +
      `kept in ${AUDIT_TABLE}. Classes: ${counts}`,
  );
  if (plan.gap) {
    log.info(
      `[datetime] gap check: ${plan.gap.gapMinutes?.toFixed(1) ?? "n/a"} min between ` +
        `${plan.gap.before?.naive ?? "-"} and ${plan.gap.after?.naive ?? "-"} (needs ${plan.gap.requiredMinutes})`,
    );
  }
  return summary;
}
