/**
 * infra/ops-check.sh (v0.29, S8) with docker, df and curl stubbed on PATH:
 * silent and 0 when clean, one line per problem and 1 otherwise, and a
 * check that cannot look, or reads a value of the wrong shape, reports
 * UNKNOWN instead of clean. infra/ops-check.sql itself runs on a real
 * Postgres in apps/cms/src/integration/cron-status.integration.test.ts;
 * here the stub answers its rows.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runBash, shellMode } from "./shell-runner.test.helper";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const SCRIPT = read("./ops-check.sh");
const SQL = read("./ops-check.sql");
const MODE = shellMode(["date", "awk", "sed", "grep"], { linux: false });

const MIN = 60_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

interface Fixture {
  /** the last-success line; null: no file */
  lastSuccess?: string | null;
  backupStatus?: string;
  /** used percentage in every df row */
  used?: number;
  /** df prints only its header */
  dfHeaderOnly?: boolean;
  /** psql's rows (kind|name|every|first|present|finished|outcome|failed), or "FAIL" */
  rows?: string[] | "FAIL";
  schemaEnv?: string;
  inspectFails?: boolean;
  push?: "ok" | "fail";
  env?: Record<string, string>;
}

const task = (name: string, every: number, firstAgo: number, status?: string) =>
  `task|${name}|${every}|${iso(firstAgo)}|${status === undefined ? "no|||" : `yes|${status}`}`;
const cleanRows = () => [
  "expected|true|array|2||||",
  task("scheduled-publisher", 1, 600 * MIN, `${iso(2 * MIN)}|ok|`),
  task("digest-mailer", 1440, 3000 * MIN, `${iso(600 * MIN)}|ok|`),
];

function run(f: Fixture = {}) {
  const used = f.used ?? 40;
  const df = [
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    ...(f.dfHeaderOnly ? [] : [`/dev/sda1 1000 ${used * 10} ${(100 - used) * 10} ${used}% /x`]),
  ].join("\\n");
  const rows = f.rows === "FAIL" ? "FAIL" : (f.rows ?? cleanRows()).join("\\n");
  const env: Record<string, string> = {
    COMPOSE_PROJECT: "prod",
    ...(f.backupStatus === undefined ? { SINNLOS_BACKUP_DIR: "$work/backup" } : {}),
    ...(f.push ? { OPS_PUSH_URL: "http://127.0.0.1:3001/api/push/abc" } : {}),
    ...f.env,
  };
  const script = [
    "set -u",
    'work="$(mktemp -d)"',
    'mkdir -p "$work/bin" "$work/infra" "$work/backup/offsite/sinnlos"',
    "cat > \"$work/infra/ops-check.sh\" <<'__OPS__'",
    SCRIPT,
    "__OPS__",
    "cat > \"$work/infra/ops-check.sql\" <<'__SQL__'",
    SQL,
    "__SQL__",
    f.lastSuccess === null
      ? ":"
      : `printf '%s\\n' '${f.lastSuccess ?? `${iso(3 * 3600_000)} nightly sinnlos-db-x.dump.gz.gpg`}' > "$work/backup/offsite/sinnlos/last-success"`,
    f.backupStatus === undefined
      ? ":"
      : `printf '%s\\n' '${f.backupStatus}' > "$work/backup-status"`,
    // docker: info → a root dir; inspect → env lines; exec … df → the df
    // table; exec … sh (psql) → the rows.
    "cat > \"$work/bin/docker\" <<'__DOCKER__'",
    "#!/usr/bin/env bash",
    'echo "$*" >> "$OPS_STUB_LOG"',
    'case "$1" in',
    "  info) echo /var/lib/docker ;;",
    `  inspect) ${f.inspectFails ? "exit 1" : `printf '%b\\n' 'PATH=/usr/bin\\n${f.schemaEnv ?? ""}'`} ;;`,
    "  exec)",
    '    case "$*" in',
    `      *" df -P "*) printf '%b\\n' '${df}' ;;`,
    `      *) cat > "$OPS_STUB_LOG.sql"; ${rows === "FAIL" ? "echo 'ERROR: invalid input syntax for type json' >&2; exit 3" : `printf '%b\\n' '${rows}'`} ;;`,
    "    esac ;;",
    "esac",
    "__DOCKER__",
    "cat > \"$work/bin/df\" <<'__DF__'",
    "#!/usr/bin/env bash",
    'echo "df $*" >> "$OPS_STUB_LOG"',
    `printf '%b\\n' '${df}'`,
    "__DF__",
    "cat > \"$work/bin/curl\" <<'__CURL__'",
    "#!/usr/bin/env bash",
    'echo "curl $*" >> "$OPS_STUB_LOG"',
    f.push === "fail" ? "exit 7" : "exit 0",
    "__CURL__",
    'chmod +x "$work/bin/"*',
    'export OPS_STUB_LOG="$work/stub.log"',
    ...Object.entries(env).map(([k, v]) => `export ${k}="${v}"`),
    ...(f.backupStatus === undefined ? [] : ['export OPS_BACKUP_STATUS="$work/backup-status"']),
    'PATH="$work/bin:$PATH" bash "$work/infra/ops-check.sh"',
    'echo "--rc=$?"',
    'echo "--log"; cat "$OPS_STUB_LOG" 2>/dev/null',
    'echo "--sql"; cat "$OPS_STUB_LOG.sql" 2>/dev/null',
  ].join("\n");
  const res = runBash(script, MODE!);
  const [out = "", rest = ""] = res.stdout.split("--rc=");
  const rc = Number(rest.split("\n")[0]);
  const log = rest.split("--log\n")[1]?.split("--sql\n")[0] ?? "";
  const sql = rest.split("--sql\n")[1] ?? "";
  return { rc, lines: out.trim() === "" ? [] : out.trim().split("\n"), log, sql };
}

// Each case runs the script a few times; Git Bash on Windows is slow at it.
describe.skipIf(MODE === null)("infra/ops-check.sh", { timeout: 60_000 }, () => {
  it("is silent and exits 0 when backup, disk and cron are in order", () => {
    const r = run();
    expect(r.lines).toEqual([]);
    expect(r.rc).toBe(0);
  });

  it("runs ops-check.sql in the db container with the cms's schema as a psql variable", () => {
    const r = run({ schemaEnv: 'DATABASE_SCHEMA=we"ird' });
    expect(r.rc).toBe(0);
    expect(r.sql.trim()).toBe(SQL.trim());
    expect(r.log).toMatch(/^exec -i prod-db-1 sh -c psql .* -v schema="\$1" .* sh we"ird$/m);
    expect(run().log).toMatch(/^exec -i prod-db-1 sh -c psql .* sh public$/m);
  });

  it("reports an old, a missing and a malformed backup sentinel", () => {
    expect(run({ lastSuccess: `${iso(27 * 3600_000)} nightly x` }).lines).toEqual([
      expect.stringMatching(
        /^backup: the last complete nightly backup is from .*, older than 26 h$/,
      ),
    ]);
    expect(run({ lastSuccess: "2026-09-29T03:00:12+02:00 nightly x" }).rc).toBe(1);
    expect(run({ lastSuccess: null }).lines[0]).toMatch(/^UNKNOWN backup age: .* is missing/);
    for (const stamp of ["now", "tomorrow", "yesterday-ish", iso(-3600_000)]) {
      expect(run({ lastSuccess: `${stamp} nightly x` }).lines[0], stamp).toMatch(
        /^UNKNOWN backup age: no valid time/,
      );
    }
    expect(run({ env: { SINNLOS_BACKUP_DIR: "" } }).lines[0]).toMatch(/^UNKNOWN backup age: set /);
  });

  it("reads backup-run's status file instead with OPS_BACKUP_STATUS", () => {
    expect(run({ backupStatus: `daily_last_ok_at=${iso(3600_000)}` }).rc).toBe(0);
    expect(run({ backupStatus: `daily_last_ok_at=${iso(30 * 3600_000)}` }).lines[0]).toMatch(
      /^backup: /,
    );
  });

  it("checks Docker's root, both volumes, the backup directory and the safety dumps", () => {
    const r = run({ used: 90 });
    expect(r.rc).toBe(1);
    expect(r.lines.every((l) => /^disk: .* has 10% free, less than 15%$/.test(l))).toBe(true);
    expect(
      r.lines.map((l) => l.replace(/ has 10% free.*$/, "").replace(/\/\S+/g, "<path>")),
    ).toEqual([
      "disk: Docker's root <path>",
      "disk: the database volume",
      "disk: the uploads volume",
      "disk: the backup directory <path>",
      "disk: the safety dumps <path>",
    ]);
    expect(r.log).toContain("df -P /var/lib/docker");
  });

  it("reports a df that prints no row as UNKNOWN, not as clean", () => {
    const r = run({ dfHeaderOnly: true });
    expect(r.rc).toBe(1);
    expect(r.lines).toHaveLength(5);
    expect(
      r.lines.every((l) => /^UNKNOWN disk space of .* printed no single usable row$/.test(l)),
    ).toBe(true);
  });

  it("reports a failed task, a recent recovered failure, a missed run and a never-run task", () => {
    const r = run({
      rows: [
        "expected|true|array|6||||",
        task("erasure-sweep", 1440, 3000 * MIN, `${iso(60 * MIN)}|failed|${iso(60 * MIN)}`),
        task("scheduled-publisher", 1, 600 * MIN, `${iso(MIN)}|ok|${iso(30 * MIN)}`),
        task("search-index", 1, 600 * MIN, `${iso(20 * MIN)}|ok|`),
        task("digest-mailer", 1440, 1600 * MIN),
        task("training-reminders", 1440, 10 * MIN),
        task("audit-janitor", 1440, 3000 * MIN, `${iso(600 * MIN)}|ok|${iso(300 * MIN)}`),
      ],
    });
    expect(r.rc).toBe(1);
    expect(r.lines).toEqual([
      expect.stringMatching(/^cron: erasure-sweep failed on its last run/),
      expect.stringMatching(/^cron: scheduled-publisher failed at .* \(it has run fine since\)$/),
      expect.stringMatching(/^cron: search-index last finished at .*, more than 16 min ago$/),
      "cron: digest-mailer has not run since it became expected (more than 1584 min)",
    ]);
  });

  it("reports CRON_ENABLED off, a missing expected set and an empty one", () => {
    expect(run({ rows: ["expected|false|array|0||||"] }).lines).toEqual([
      "cron: the cms runs with CRON_ENABLED off; no task runs",
    ]);
    expect(run({ rows: [] }).lines).toEqual([
      "UNKNOWN cron status: no cron:expected entry (has the cms booted since v0.29?)",
    ]);
    expect(run({ rows: ["expected|true|array|0||||"] }).lines).toEqual([
      "UNKNOWN cron status: cron:expected lists no task although cron is on",
    ]);
  });

  it("reports a value of the wrong shape as UNKNOWN, never as clean", () => {
    const unknown = (rows: string[]) => run({ rows }).lines;
    // cron:expected without a task list, or with cronEnabled not a boolean
    expect(unknown(["expected|true|||||||"])).toEqual([
      "UNKNOWN cron status: cron:expected has the wrong shape",
    ]);
    expect(unknown(["expected||array|1||||", task("x", 1, MIN, `${iso(MIN)}|ok|`)])).toEqual([
      "UNKNOWN cron status: cron:expected has the wrong shape",
    ]);
    const head = "expected|true|array|1||||";
    expect(unknown([head, task("x", 1, MIN, `${iso(MIN)}|garbage|`)])).toEqual([
      "UNKNOWN cron status: unreadable status of task x",
    ]);
    // a status row without its finish time is not the same as no row
    expect(unknown([head, task("x", 1, MIN, "|ok|")])).toEqual([
      "UNKNOWN cron status: unreadable status of task x",
    ]);
    expect(unknown([head, task("x", 1, MIN, "tomorrow|ok|")])).toEqual([
      "UNKNOWN cron status: unreadable status of task x",
    ]);
    expect(unknown([head, `task|x|1|now|no|||`])).toEqual([
      "UNKNOWN cron status: unreadable expected entry for task 'x'",
    ]);
    expect(unknown([head, task("x", 0, MIN)])).toEqual([
      "UNKNOWN cron status: unreadable expected entry for task 'x'",
    ]);
  });

  it("reports UNKNOWN when docker or psql cannot answer", () => {
    expect(run({ inspectFails: true }).lines).toContain(
      "UNKNOWN cron status: docker inspect prod-cms-1 failed",
    );
    expect(run({ rows: "FAIL" }).lines[0]).toMatch(
      /^UNKNOWN cron status: psql in prod-db-1 failed: ERROR: invalid input syntax/,
    );
  });

  it("pings OPS_PUSH_URL only when clean, and reports a failed push", () => {
    expect(run({ push: "ok" }).log).toContain(
      "curl -fsS --max-time 10 -o /dev/null http://127.0.0.1:3001/api/push/abc",
    );
    const failed = run({ push: "fail" });
    expect(failed.lines).toEqual(["UNKNOWN monitor: the push to OPS_PUSH_URL failed"]);
    expect(failed.rc).toBe(1);
    expect(run({ push: "ok", used: 95 }).log).not.toContain("curl");
  });
});
