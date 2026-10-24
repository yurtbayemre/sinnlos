/**
 * infra/restore-db.sh: the database restore of docs/DEPLOYMENT.md §7.1 as a
 * script with an on-disk attempt state. Pinned:
 *   1. prepare copies the dump into the attempt's own staged file and checks
 *      that copy in full (it lists a table AND decodes to the end) before
 *      anything changes; later steps read only the staged copy, so a dump
 *      path swapped or rewritten after prepare changes nothing; web and cms
 *      stop, and a NEW copy of the database (never overwritten, checked the
 *      same way) exists before any drop;
 *   2. every prepare first ends the eligibility of the attempt before it,
 *      also when it fails; apply drops only for the live attempt, whose
 *      staged dump still has its sha256 and decodes, and only with the
 *      attempt's intact copy when the database exists (checked with the apps
 *      stopped); it restores into a clean database in one transaction and
 *      requires the dump's tables and a user; a failed createdb or restore
 *      can be retried, and `back` returns to the database from before the
 *      restore, also after a failed way back;
 *   3. the state files are untrusted data: mode 600 of the owner, known
 *      keys once, every value in its form, paths derived from the attempt id;
 *   4. rotate-jwt refuses an exported JWT_SECRET and an .env without
 *      exactly one JWT_SECRET= line, writes a fresh value (mode 600) and
 *      passes only when Compose hands the cms that value; no secret in any
 *      output, also under bash -x;
 *   5. start needs apply and rotate-jwt of the same live attempt (or the
 *      --env-only pair, refused while a restore holds the reservation) and
 *      the rotated secret still effective; it ends the attempt and the
 *      reservation, which prepare takes and cancel (only before apply)
 *      releases;
 *   6. one step at a time per compose project (the deploy lock); the
 *      compose files are the ordered list of the project's web and cms
 *      containers (overlays such as the cms legacy-zone file kept), known
 *      files of the checkout, or RESTORE_COMPOSE_FILES, the same for every
 *      step of an attempt.
 *
 * The fast sequences run the real script with docker and flock stubbed as
 * exported shell functions: the stub keeps a fake database (one line per
 * table) and reads fake archives (FAKEDUMP, "table <name> <rows>" lines,
 * END; without END the table of contents lists but the data is cut). The
 * slow sequences (SINNLOS_SLOW_SHELL_TESTS=1, Docker) run it against a real
 * Postgres 16 in a throwaway compose project rs-<n>. Both need Linux (flock,
 * file modes): natively, or in SINNLOS_SHELL_RUNNER_IMAGE on Windows
 * (infra/shell-runner.test.helper.ts).
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  dockerReachable,
  runBash,
  shellMode,
  skipReason,
  type ShellMode,
} from "./shell-runner.test.helper";

const SCRIPT = readFileSync(new URL("./restore-db.sh", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
const TOOLS = ["flock", "openssl", "git", "sha256sum", "stat", "mktemp", "awk", "sed", "readlink"];
const MODE: ShellMode | null = shellMode(TOOLS, { linux: true });
const SLOW = process.env.SINNLOS_SLOW_SHELL_TESTS === "1";
const SLOW_MODE: ShellMode | null = SLOW ? shellMode([...TOOLS, "docker"], { linux: true }) : null;
const RUN_SLOW = SLOW_MODE !== null && dockerReachable(SLOW_MODE);

describe("restore-db.sh: the script itself", () => {
  const lines = SCRIPT.split("\n");
  const code = lines.filter((l) => !/^\s*#/.test(l) && l.trim() !== "");

  it("turns tracing off first, then errexit, nounset, pipefail and umask 077", () => {
    expect(lines[0]).toBe("#!/usr/bin/env bash");
    expect(code[0]).toMatch(/^set \+x\b/);
    expect(code).toContain("set -Eeuo pipefail");
    expect(code).toContain("umask 077");
  });

  it("hands the new secret to awk through its environment, never its command line", () => {
    expect(SCRIPT).toContain('NEW_JWT_SECRET="${new}" awk');
    expect(SCRIPT).toContain('ENVIRON["NEW_JWT_SECRET"]');
    expect(SCRIPT).not.toMatch(/awk -v [a-z_]+="\$\{?new\}?"/);
    // The value is only ever hashed or written, never printed.
    for (const line of code.filter((l) => l.includes("${new}"))) {
      expect(line, line).toMatch(
        /new=|=~|printf '%s\\n' "\$\{new\}" \| sha256sum|NEW_JWT_SECRET="\$\{new\}"/,
      );
    }
  });

  it("documents its exit codes and holds the deploy lock", () => {
    expect(SCRIPT).toContain(
      "# Exit codes: 0 OK, 1 STOP (a check or a command failed; the STOP line says\n# what changed and what to do), 2 usage, 3 another restore step or a deploy\n# of the project holds the lock (nothing changed).",
    );
    expect(SCRIPT).toContain('LOCK_FILE="${LOCK_DIR}/${PROJECT}.lock"');
    expect(SCRIPT).toContain('LOCK_DIR="${DEPLOY_STATE_DIR:-${REPO_GIT_DIR}/sinnlos-deploy}"');
    expect(SCRIPT).toContain('RESERVATION="${STATE_DIR}/${PROJECT}.reservation"');
  });

  it("restores the staged dump into a clean database in one transaction that stops at the first error", () => {
    expect(SCRIPT).toContain(
      `'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'`,
    );
    expect(SCRIPT).toContain(
      `'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction' </dev/fd/7`,
    );
    expect(SCRIPT).toContain('exec 7<"${stage}"');
    expect(SCRIPT).not.toMatch(/pg_restore[^\n]*--clean/);
  });

  it("reads its state files as data, never as code", () => {
    expect(SCRIPT).not.toMatch(/^\s*(source|\.)\s/m);
    expect(SCRIPT).toContain('printf -v "${prefix}${key}" \'%s\' "${value}"');
  });
});

/** One run of restore-db.sh in a sequence. */
interface Step {
  /** Bash run before the step (harness variables and STUB_* switches in scope). */
  before?: string;
  args: string[];
  env?: Record<string, string>;
  /** Runs the script under `bash -x`. */
  xtrace?: boolean;
}

interface StepReport {
  status: number;
  stdout: string;
  stderr: string;
  /** docker calls of this step. */
  calls: string[];
  /** infra.state after the step (key -> value). */
  state: Record<string, string>;
  envOnly: Record<string, string>;
  /** The fake database's tables ("name rows"), or null when it does not exist. */
  db: string[] | null;
  /** The JWT_SECRET= values of infra/.env and its mode. */
  jwt: string[];
  envMode: string;
  /** sha256 of the JWT_SECRET the last `up` handed the cms ("" before any). */
  startedJwtSum: string;
  /** "running" or "stopped". */
  apps: string;
  /** Entries of infra/backups. */
  backups: string[];
  /** Staged dumps: "<dir> <dir mode> <file mode>". */
  stages: string[];
  /** Archived attempt states (<project>.<attempt>.state). */
  archived: number;
  /** Whether the reservation file exists, and what it holds. */
  reserved: boolean;
  reservation: Record<string, string>;
  /** The checkout ($REPO). */
  checkout: string;
}

/** A fake pg_dump archive: FAKEDUMP, table lines, END (cut: no END). */
const fakeDump = (name: string, tables: string[], opts: { cut?: boolean; extra?: string[] } = {}) =>
  [
    `{ echo FAKEDUMP; printf '%s\\n' ${tables.map((t) => `'table ${t}'`).join(" ")}`,
    ...(opts.extra ?? []).map((l) => `echo '${l}'`),
    opts.cut ? "" : "echo END",
    `} > "$T/${name}"`,
  ]
    .filter(Boolean)
    .join("; ");

const HARNESS_STUBS = readFileSync(
  new URL("./restore-db.test-stubs.sh", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** The config_files label of production's containers in the harness checkout. */
const TRAEFIK_LABEL = "$REPO/infra/docker-compose.yml,$REPO/infra/docker-compose.traefik.yml";

/**
 * Runs the steps in one bash process, in a fresh checkout ($REPO, a git
 * repo) with the real restore-db.sh, an infra/.env (JWT_SECRET=old-secret),
 * empty compose files (base, Traefik overlay, cms legacy-zone overlay) and
 * a database of three tables (up_users 3, posts 5, rsvps 2); web, cms and db
 * containers carry the label of base + Traefik overlay. Fake dumps in $T:
 * good.dump (up_users, posts), cut.dump (good.dump without its end),
 * garbage.dump, grant.dump (fails to restore), nousers.dump, older.dump
 * (up_users 2).
 */
function restoreSteps(steps: readonly Step[], mode: ShellMode): StepReport[] {
  const script: string[] = [
    "set -uo pipefail",
    "umask 077",
    'T="$(mktemp -d)"',
    "trap 'rm -rf \"$T\"' EXIT",
    'REPO="$T/checkout"',
    'mkdir -p "$REPO/infra" "$T/db"',
    "cat > \"$REPO/infra/restore-db.sh\" <<'RESTORE_DB_EOF'",
    SCRIPT.trimEnd(),
    "RESTORE_DB_EOF",
    'chmod 755 "$REPO/infra/restore-db.sh"',
    'for f in docker-compose.yml docker-compose.traefik.yml; do : > "$REPO/infra/$f"; done',
    "printf 'DATABASE_PASSWORD=pw\\nJWT_SECRET=old-secret\\nAUTH_SECRET=keep-me\\n' > \"$REPO/infra/.env\"",
    'G=(git -C "$REPO" -c user.name=restore-test -c user.email=restore-test@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main -c core.hooksPath=/dev/null)',
    '"${G[@]}" init -q && "${G[@]}" add -A && "${G[@]}" commit -q -m first',
    "printf 'up_users 3\\nposts 5\\nrsvps 2\\n' > \"$T/db/tables\"",
    'echo running > "$T/apps"',
    fakeDump("good.dump", ["up_users 3", "posts 5"]),
    fakeDump("cut.dump", ["up_users 3", "posts 5"], { cut: true }),
    "echo 'not a dump' > \"$T/garbage.dump\"",
    fakeDump("grant.dump", ["up_users 3", "posts 5"], {
      extra: ["GRANT SELECT ON up_users TO walk_reader"],
    }),
    fakeDump("nousers.dump", ["notes 1", "tags 2"]),
    fakeDump("older.dump", ["up_users 2"]),
    "STEP_CWD=",
    `STUB_LABEL_WEB="${TRAEFIK_LABEL}" STUB_LABEL_CMS="${TRAEFIK_LABEL}" STUB_LABEL_DB="${TRAEFIK_LABEL}"`,
    "export T REPO STUB_LABEL_WEB STUB_LABEL_CMS STUB_LABEL_DB STUB_STOP_FAIL= STUB_UP_FAIL= STUB_ON_STOP= STUB_RM_AS_USER= STUB_KILL_AFTER_STARTED= STUB_PGDUMP_FAIL= STUB_CREATEDB_FAIL= STUB_RESTORE_FAIL= STUB_LOCK_HELD= STUB_SITE_ALLOW=",
    'S="$REPO/.git/sinnlos-deploy/restore"',
    HARNESS_STUBS,
  ];
  steps.forEach((step, n) => {
    const env = Object.entries(step.env ?? {})
      .map(([key, value]) => `${key}='${value.replace(/'/g, `'\\''`)}'`)
      .join(" ");
    const args = step.args.map((a) => `'${a}'`).join(" ");
    const bash = step.xtrace ? "bash -x" : "bash";
    script.push(
      ': > "$T/calls"',
      step.before ?? "",
      // STEP_CWD (set in `before`): another working directory than $T.
      `(cd "\${STEP_CWD:-$T}" && env ${env} ${bash} "$REPO/infra/restore-db.sh" ${args} > "$T/out" 2> "$T/err"); rc=$?`,
      `echo "@@STEP ${n} $rc"`,
      'sed "s/^/@@OUT /" "$T/out"',
      'sed "s/^/@@ERR /" "$T/err"',
      'sed "s/^/@@CALL /" "$T/calls"',
      'if [[ -f "$S/infra.state" ]]; then sed "s/^/@@STATE /" "$S/infra.state"; fi',
      'if [[ -f "$S/infra.env-only.state" ]]; then sed "s/^/@@ENVONLY /" "$S/infra.env-only.state"; fi',
      'if [[ -d "$T/db" ]]; then echo "@@DBEXISTS"; sed "s/^/@@DB /" "$T/db/tables"; fi',
      'sed -n "s/^JWT_SECRET=/@@JWT /p" "$REPO/infra/.env" 2>/dev/null',
      'echo "@@ENVMODE $(stat -c %a "$REPO/infra/.env" 2>/dev/null)"',
      'echo "@@STARTED $(cat "$T/started-jwt" 2>/dev/null)"',
      'echo "@@APPS $(cat "$T/apps")"',
      'for f in "$REPO"/infra/backups/*; do if [[ -e "$f" ]]; then echo "@@BACKUP ${f##*/}"; fi; done',
      'for f in "$REPO"/infra/backups/restore-*; do if [[ -d "$f" ]]; then echo "@@STAGE ${f##*/} $(stat -c %a "$f") $(stat -c %a "$f/dump" 2>/dev/null)"; fi; done',
      'echo "@@ARCHIVED $(ls "$S" 2>/dev/null | grep -c "^infra\\.[0-9].*\\.state$")"',
      'if [[ -e "$S/infra.reservation" ]]; then echo "@@RESERVED 1"; sed "s/^/@@RES /" "$S/infra.reservation"; else echo "@@RESERVED 0"; fi',
      'echo "@@CHECKOUT $REPO"',
    );
  });
  script.push("");
  const res = runBash(script.join("\n"), mode);
  expect(res.stderr, "harness stderr").toBe("");
  const reports: StepReport[] = [];
  let current: StepReport | null = null;
  let dbExists = false;
  for (const line of res.stdout.split("\n")) {
    const stepMatch = /^@@STEP (\d+) (-?\d+)$/.exec(line);
    if (stepMatch) {
      current = {
        status: Number(stepMatch[2]),
        stdout: "",
        stderr: "",
        calls: [],
        state: {},
        envOnly: {},
        db: null,
        jwt: [],
        envMode: "",
        startedJwtSum: "",
        apps: "",
        backups: [],
        stages: [],
        archived: 0,
        reserved: false,
        reservation: {},
        checkout: "",
      };
      dbExists = false;
      reports.push(current);
      continue;
    }
    if (!current) continue;
    const [tag, ...rest] = line.split(" ");
    const value = rest.join(" ");
    const kv = (into: Record<string, string>) => {
      if (value.startsWith("#")) return;
      const eq = value.indexOf("=");
      into[value.slice(0, eq)] = value.slice(eq + 1);
    };
    if (tag === "@@OUT") current.stdout += `${value}\n`;
    else if (tag === "@@ERR") current.stderr += `${value}\n`;
    else if (tag === "@@CALL") current.calls.push(value);
    else if (tag === "@@STATE") kv(current.state);
    else if (tag === "@@ENVONLY") kv(current.envOnly);
    else if (tag === "@@DBEXISTS") {
      dbExists = true;
      current.db = [];
    } else if (tag === "@@DB" && dbExists) current.db?.push(value);
    else if (tag === "@@JWT") current.jwt.push(value);
    else if (tag === "@@ENVMODE") current.envMode = value;
    else if (tag === "@@STARTED") current.startedJwtSum = value;
    else if (tag === "@@APPS") current.apps = value;
    else if (tag === "@@BACKUP") current.backups.push(value);
    else if (tag === "@@STAGE") current.stages.push(value);
    else if (tag === "@@ARCHIVED") current.archived = Number(value);
    else if (tag === "@@RESERVED") current.reserved = value === "1";
    else if (tag === "@@RES") kv(current.reservation);
    else if (tag === "@@CHECKOUT") current.checkout = value;
  }
  expect(reports, res.stdout).toHaveLength(steps.length);
  return reports;
}

const sha256 = async (s: string) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`${s}\n`).digest("hex");
};
const dropped = (r: StepReport) => r.calls.some((c) => c.includes("dropdb"));
const stopLine = (r: StepReport) => r.stderr.split("\n").find((l) => l.startsWith("STOP: ")) ?? "";
const okLine = (r: StepReport) => r.stdout.split("\n").find((l) => l.startsWith("OK: ")) ?? "";
/** The copy an attempt took of the database. */
const copyOf = (r: StepReport, attempt: string) =>
  `${r.checkout}/infra/backups/before-restore-${attempt}.dump`;
const copies = (r: StepReport) => r.backups.filter((b) => b.startsWith("before-restore-"));

const FAST = MODE !== null;
const FAST_TITLE = FAST ? "" : ` (skipped: ${skipReason(TOOLS)})`;

describe.skipIf(!FAST)(`restore-db.sh: a good restore, step by step${FAST_TITLE}`, () => {
  let r: StepReport[] = [];
  beforeAll(() => {
    r = restoreSteps(
      [
        /* 0 */ { args: ["prepare", "good.dump"] },
        /* 1 */ { args: ["status"] },
        /* 2 */ { args: ["apply"] },
        /* 3 */ { args: ["rotate-jwt"] },
        /* 4 */ { args: ["start"] },
        /* 5 */ { args: ["status"] },
        /* 6 */ { args: ["start"] },
        /* 7 */ { args: ["apply"] },
        /* 8 */ { args: ["back"] },
      ],
      MODE as ShellMode,
    );
  }, 300_000);

  it("prepare stages and checks the dump, reserves, stops the apps and writes a new, checked copy", () => {
    expect(r[0].status, r[0].stderr).toBe(0);
    const id = r[0].state.ATTEMPT;
    expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
    expect(okLine(r[0])).toBe(
      `OK: attempt ${id}: ${r[0].state.SOURCE} holds 2 tables (staged in ${r[0].checkout}/infra/backups/restore-${id}); web and cms stopped; the current database (3 tables) is saved in ${copyOf(r[0], id)}. Next: infra/restore-db.sh apply`,
    );
    expect(r[0].state.SOURCE).toMatch(/\/good\.dump$/);
    expect(r[0].apps).toBe("stopped");
    expect(r[0].reserved).toBe(true);
    expect(dropped(r[0])).toBe(false);
    expect(r[0].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
    expect(copies(r[0])).toEqual([`before-restore-${id}.dump`]);
    // The staged copy: a mode-700 directory with a mode-600 file.
    expect(r[0].stages).toEqual([`restore-${id} 700 600`]);
    // The staged dump is checked in full (list and decode), and so is the copy.
    expect(r[0].calls.filter((c) => c.endsWith("exec -T db pg_restore --list"))).toHaveLength(2);
    expect(
      r[0].calls.filter((c) => c.endsWith("exec -T db pg_restore --file=/dev/null")),
    ).toHaveLength(2);
    // The compose files of the project's containers, in their order.
    expect(r[0].calls.find((c) => c.includes(" stop web cms"))).toBe(
      `docker compose -p infra -f ${r[0].checkout}/infra/docker-compose.yml -f ${r[0].checkout}/infra/docker-compose.traefik.yml stop web cms`,
    );
  });

  it("records the attempt on disk: no path but the dump's source, sha256 and counts", () => {
    const s = r[0].state;
    expect(Object.keys(s).sort()).toEqual(
      [
        "ATTEMPT",
        "PROJECT",
        "CHECKOUT",
        "COMPOSE_FILES",
        "SOURCE",
        "DUMP_SHA256",
        "DUMP_TABLES",
        "SAFETY",
        "SAFETY_SHA256",
        "SAFETY_TABLES",
        "ORIGIN_ATTEMPT",
        "ORIGIN_SHA256",
        "BACK_OF",
        "PREPARED_AT",
        "SUPERSEDED_AT",
        "CANCELLED_AT",
        "APPLY_STARTED_AT",
        "APPLIED_AT",
        "RESTORED_TABLES",
        "USERS",
        "ROTATED_AT",
        "ROTATED_SUM",
        "STARTED_AT",
      ].sort(),
    );
    expect(s.PROJECT).toBe("infra");
    expect(s.COMPOSE_FILES).toBe(
      `${r[0].checkout}/infra/docker-compose.yml,${r[0].checkout}/infra/docker-compose.traefik.yml`,
    );
    expect(s.DUMP_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.DUMP_TABLES).toBe("2");
    expect(s.SAFETY).toBe("yes");
    expect(s.SAFETY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.SAFETY_TABLES).toBe("3");
    expect(s.ORIGIN_ATTEMPT).toBe(s.ATTEMPT);
    expect(s.ORIGIN_SHA256).toBe(s.SAFETY_SHA256);
    expect(s.PREPARED_AT).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(s.APPLY_STARTED_AT).toBe("");
    expect(r[1].stdout).toContain(`attempt ${s.ATTEMPT} of compose project infra (checkout`);
    expect(r[1].stdout).toContain("next:      infra/restore-db.sh apply (or cancel)");
    expect(r[1].stdout).toContain("reserved:  ");
  });

  it("apply restores the staged dump into a clean database and checks tables and users", () => {
    expect(r[2].status, r[2].stderr).toBe(0);
    expect(okLine(r[2])).toBe(
      `OK: attempt ${r[0].state.ATTEMPT}: restored 2 tables (the dump has 2) and 3 users into a clean database. Next: infra/restore-db.sh rotate-jwt`,
    );
    expect(r[2].db).toEqual(["up_users 3", "posts 5"]);
    const stop = r[2].calls.findIndex((c) => c.endsWith(" stop web cms"));
    const exists = r[2].calls.findIndex((c) => c.includes("-d postgres"));
    const drop = r[2].calls.findIndex((c) => c.includes("dropdb"));
    const restore = r[2].calls.findIndex((c) => c.includes("--single-transaction"));
    expect(stop).toBeGreaterThanOrEqual(0);
    // The database is asked for after the apps stopped, and before the drop.
    expect(stop).toBeLessThan(exists);
    expect(exists).toBeLessThan(drop);
    expect(drop).toBeLessThan(restore);
    expect(r[2].state.APPLIED_AT).not.toBe("");
    expect(r[2].state.RESTORED_TABLES).toBe("2");
    expect(r[2].state.USERS).toBe("3");
    expect(r[2].reserved).toBe(true);
  });

  it("rotate-jwt writes one fresh JWT_SECRET (mode 600) that Compose hands the cms, and prints none", async () => {
    expect(r[3].status, r[3].stderr).toBe(0);
    expect(r[3].jwt).toHaveLength(1);
    const secret = r[3].jwt[0];
    expect(secret).toMatch(/^[A-Za-z0-9+/]{64}$/);
    expect(secret).not.toBe("old-secret");
    expect(r[3].envMode).toBe("600");
    expect(r[3].state.ROTATED_SUM).toBe(await sha256(secret));
    for (const report of r) {
      expect(report.stdout + report.stderr + report.calls.join("\n")).not.toContain(secret);
      expect(Object.values(report.state).join("\n")).not.toContain(secret);
    }
  });

  it("start brings web and cms up with the rotated secret and ends the attempt and the reservation", async () => {
    expect(r[4].status, r[4].stderr).toBe(0);
    expect(r[4].apps).toBe("running");
    expect(r[4].startedJwtSum).toBe(await sha256(r[3].jwt[0]));
    expect(r[4].calls).toContainEqual(expect.stringMatching(/ up -d --no-build web cms$/));
    // The site is open (no SITE_ALLOW_CIDRS): the reminder, before the start.
    expect(r[4].stdout).toContain(
      '  The site will be public. If anonymisations must be repeated, close it first (docs/OPERATIONS.md, "Restore").',
    );
    expect(r[4].state.STARTED_AT).not.toBe("");
    expect(r[4].reserved).toBe(false);
    expect(r[4].stages).toEqual([]);
    expect(r[5].stdout).toContain("next:      nothing (done); another restore starts with prepare");
    expect(r[6].status).toBe(1);
    expect(r[7].status).toBe(1);
    expect(stopLine(r[7])).toContain("is used up");
    expect(dropped(r[7])).toBe(false);
  });

  it("back after a finished restore prepares the copy taken before it", () => {
    expect(r[8].status, r[8].stderr).toBe(0);
    expect(r[8].state.SOURCE).toBe(copyOf(r[8], r[0].state.ATTEMPT));
    expect(r[8].state.DUMP_SHA256).toBe(r[0].state.SAFETY_SHA256);
    expect(r[8].state.DUMP_TABLES).toBe("3");
    expect(r[8].state.BACK_OF).toBe(r[0].state.ATTEMPT);
    expect(r[8].reserved).toBe(true);
  });
});

describe.skipIf(!FAST)(`restore-db.sh: dumps that must not be restored${FAST_TITLE}`, () => {
  let r: StepReport[] = [];
  beforeAll(() => {
    r = restoreSteps(
      [
        /* 0 */ { args: ["prepare", "missing.dump"] },
        /* 1 */ { args: ["prepare", "cut.dump"] },
        /* 2 */ { args: ["prepare", "garbage.dump"] },
        /* 3 */ { args: ["apply"] },
        /* 4 */ { args: ["prepare", "nousers.dump"] },
        /* 5 */ { args: ["apply"] },
        /* 6 */ { args: ["rotate-jwt"] },
        /* 7 */ { args: ["start"] },
      ],
      MODE as ShellMode,
    );
  }, 300_000);

  it("a missing, a cut-off (table of contents intact) and an unreadable dump change nothing", () => {
    for (const report of r.slice(0, 3)) {
      expect(report.status).toBe(1);
      expect(report.apps).toBe("running");
      expect(report.calls.some((c) => c.includes(" stop "))).toBe(false);
      expect(report.backups).toEqual([]);
      expect(report.state).toEqual({});
      expect(report.reserved).toBe(false);
    }
    expect(stopLine(r[0])).toMatch(
      /missing\.dump is missing, empty or not readable; nothing changed$/,
    );
    // The cut dump lists its tables; only decoding it to the end fails.
    expect(r[1].calls).toContainEqual(expect.stringMatching(/pg_restore --list$/));
    expect(r[1].stderr).toContain("could not read from input file: end of file");
    expect(stopLine(r[1])).toContain("cut.dump is no readable dump");
    expect(stopLine(r[2])).toContain(
      "garbage.dump is no readable dump (it must list at least one table and decode to the end; tables: none); nothing changed",
    );
    expect(stopLine(r[3])).toBe(
      "STOP: no prepared attempt of project infra: run infra/restore-db.sh prepare <dump> first; nothing dropped",
    );
    expect(r[3].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
  });

  it("a dump without up_users is restored but fails the check, and nothing starts", () => {
    expect(r[4].status, r[4].stderr).toBe(0);
    expect(r[5].status).toBe(1);
    expect(stopLine(r[5])).toContain(
      "the check queries failed (no up_users table: not a sinnlos dump?)",
    );
    expect(r[5].state.APPLIED_AT).toBe("");
    expect(r[6].status).toBe(1);
    expect(r[7].status).toBe(1);
    expect(r[7].apps).toBe("stopped");
    expect(r[7].jwt).toEqual(["old-secret"]);
  });
});

describe.skipIf(!FAST)(
  `restore-db.sh: the staged dump and the copy between prepare and apply${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { before: 'ln -s good.dump "$T/link.dump"', args: ["prepare", "link.dump"] },
          // The path now leads to another readable dump, and the file it led to changes too.
          /* 1 */ {
            before: `ln -sfn older.dump "$T/link.dump"; ${fakeDump("good.dump", ["up_users 9"])}`,
            args: ["apply"],
          },
          /* 2 */ { args: ["prepare", "older.dump"] },
          /* 3 */ { before: 'printf x >> "$REPO"/infra/backups/restore-*/dump', args: ["apply"] },
          /* 4 */ { args: ["prepare", "older.dump"] },
          /* 5 */ { before: 'rm "$REPO"/infra/backups/before-restore-*.dump', args: ["apply"] },
          /* 6 */ { args: ["prepare", "older.dump"] },
          /* 7 */ {
            before:
              'for f in "$REPO"/infra/backups/before-restore-*.dump; do printf x >> "$f"; done',
            args: ["apply"],
          },
          /* 8 */ { args: ["prepare", "older.dump"] },
          /* 9 */ { before: 'STEP_CWD="$REPO/infra"', args: ["apply"] },
          /* 10 */ { before: "STEP_CWD=; STUB_PGDUMP_FAIL=1", args: ["prepare", "older.dump"] },
          /* 11 */ { before: "STUB_PGDUMP_FAIL=", args: ["status"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("restores the dump as staged: a swapped symlink and a rewritten file after prepare do nothing", () => {
      // Before the review fix apply reopened the caller's path and restored
      // whatever it led to then.
      expect(r[0].state.SOURCE).toMatch(/\/good\.dump$/);
      expect(r[1].status, r[1].stderr).toBe(0);
      expect(r[1].db).toEqual(["up_users 3", "posts 5"]);
    });

    it("a staged dump that changed stops apply before the drop", () => {
      expect(r[3].status).toBe(1);
      expect(stopLine(r[3])).toContain(
        "changed since prepare; nothing dropped (start again with prepare)",
      );
      expect(dropped(r[3])).toBe(false);
    });

    it("a deleted or changed copy stops apply before the drop", () => {
      for (const n of [5, 7]) {
        expect(r[n].status, `step ${n}`).toBe(1);
        expect(stopLine(r[n])).toContain(
          "is gone, changed or no longer decodes; nothing dropped (start again with prepare, which writes a new copy)",
        );
        expect(dropped(r[n])).toBe(false);
      }
      expect(r[7].db).toEqual(["up_users 3", "posts 5"]);
    });

    it("each prepare writes a new copy, ends the attempt before it and drops its staged dump", () => {
      expect(new Set(copies(r[8])).size).toBe(copies(r[8]).length);
      expect(r[8].archived).toBe(4);
      expect(r[8].stages).toEqual([`restore-${r[8].state.ATTEMPT} 700 600`]);
      // The state names no path to read but the source; another working directory works.
      expect(r[9].status, r[9].stderr).toBe(0);
    });

    it("a failing pg_dump leaves no copy and no new attempt; the attempt before it is ended", () => {
      expect(r[10].status).toBe(1);
      expect(stopLine(r[10])).toBe(
        "STOP: no usable copy of the current database (pg_dump or its check failed); web and cms are stopped; nothing dropped (the project is reserved: prepare again, or cancel)",
      );
      expect(copies(r[10])).toEqual(copies(r[9]));
      expect(r[10].stages).toEqual([]);
      expect(r[10].state.ATTEMPT).toBe(r[8].state.ATTEMPT);
      expect(r[10].state.SUPERSEDED_AT).not.toBe("");
      expect(r[10].reserved).toBe(true);
      expect(r[11].stdout).toContain(`attempt ${r[8].state.ATTEMPT}`);
      expect(r[11].stdout).toContain("ended:     ");
    });
  },
);

describe.skipIf(!FAST)(
  `restore-db.sh: a race between the last check and the restore${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { before: 'ln -s good.dump "$T/link.dump"', args: ["prepare", "link.dump"] },
          // When the apps stop, after every check: the path given to prepare leads elsewhere.
          /* 1 */ {
            before: `STUB_ON_STOP='ln -sfn older.dump "$T/link.dump"'`,
            args: ["apply"],
          },
          /* 2 */ { before: "STUB_ON_STOP=", args: ["prepare", "good.dump"] },
          // … and the staged file itself is replaced by another dump.
          /* 3 */ {
            before: `STUB_ON_STOP='printf "FAKEDUMP\ntable up_users 1\nEND\n" > "$T/swap"; mv -f "$T/swap" "$REPO"/infra/backups/restore-*/dump'`,
            args: ["apply"],
          },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("restores the bytes it checked, whatever the dump's paths lead to by then", () => {
      // Before the review fix apply checked the caller's path, then reopened
      // it for pg_restore: here it would have restored older.dump.
      expect(r[1].status, r[1].stderr).toBe(0);
      expect(r[1].db).toEqual(["up_users 3", "posts 5"]);
      // The staged dump is read through the descriptor its check opened.
      expect(r[3].status, r[3].stderr).toBe(0);
      expect(r[3].db).toEqual(["up_users 3", "posts 5"]);
    });
  },
);

describe.skipIf(!FAST)(
  `restore-db.sh: a later prepare ends the attempt before it, also when it fails${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { args: ["prepare", "missing.dump"] },
          /* 2 */ { args: ["apply"] },
          /* 3 */ { args: ["rotate-jwt"] },
          /* 4 */ { args: ["start"] },
          /* 5 */ { args: ["status"] },
          /* 6 */ { args: ["prepare", "good.dump"] },
          /* 7 */ { args: ["apply"] },
          /* 8 */ { args: ["prepare", "cut.dump"] },
          /* 9 */ { args: ["rotate-jwt"] },
          /* 10 */ { args: ["back"] },
          /* 11 */ { args: ["apply"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("prepare A, then a failing prepare B: A can no longer be applied, rotated or started", () => {
      // Before the review fix the failed prepare left A eligible, and apply restored it.
      expect(r[0].status, r[0].stderr).toBe(0);
      expect(r[1].status).toBe(1);
      expect(r[1].state.ATTEMPT).toBe(r[0].state.ATTEMPT);
      expect(r[1].state.SUPERSEDED_AT).not.toBe("");
      expect(r[1].stages).toEqual([]);
      for (const n of [2, 3, 4]) expect(r[n].status, `step ${n}`).toBe(1);
      expect(stopLine(r[2])).toContain(`attempt ${r[0].state.ATTEMPT} was ended at `);
      expect(dropped(r[2])).toBe(false);
      expect(r[2].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
      expect(r[4].apps).toBe("stopped");
      expect(r[5].stdout).toContain("next:      infra/restore-db.sh prepare <dump> (or back)");
    });

    it("an applied attempt ended by a failing prepare cannot be rotated, but back still leads home", () => {
      expect(r[7].status, r[7].stderr).toBe(0);
      expect(r[8].status).toBe(1);
      expect(r[9].status).toBe(1);
      expect(stopLine(r[9])).toContain("apply did not pass for the current attempt");
      expect(r[10].status, r[10].stderr).toBe(0);
      // Attempt 6 began its apply and was not started: back goes to the copy before it.
      expect(r[10].state.SOURCE).toBe(copyOf(r[10], r[6].state.ATTEMPT));
      expect(r[11].status, r[11].stderr).toBe(0);
      expect(r[11].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
    });
  },
);

describe.skipIf(!FAST)(
  `restore-db.sh: failures inside apply, retries and the way back${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { before: "STUB_CREATEDB_FAIL=1", args: ["apply"] },
          /* 2 */ { before: "STUB_CREATEDB_FAIL=", args: ["status"] },
          /* 3 */ { args: ["rotate-jwt"] },
          /* 4 */ { args: ["start"] },
          /* 5 */ { args: ["apply"] },
          /* 6 */ { args: ["rotate-jwt"] },
          /* 7 */ { args: ["start"] },
          /* 8 */ { args: ["prepare", "grant.dump"] },
          /* 9 */ { args: ["apply"] },
          /* 10 */ { args: ["back"] },
          /* 11 */ { before: "STUB_RESTORE_FAIL=1", args: ["apply"] },
          /* 12 */ { before: "STUB_RESTORE_FAIL=", args: ["back"] },
          /* 13 */ { args: ["apply"] },
          /* 14 */ { args: ["rotate-jwt"] },
          /* 15 */ { args: ["start"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("a createdb that fails after the drop: STOP, nothing starts, and apply again restores", () => {
      expect(r[1].status).toBe(1);
      expect(stopLine(r[1])).toBe(
        "STOP: the database was dropped and createdb failed: it does not exist now; fix the cause and run infra/restore-db.sh apply again (or back); do not start the apps",
      );
      expect(r[1].db).toBeNull();
      expect(r[2].stdout).toContain(
        "next:      the database may be empty or not yet checked: apply again, or back",
      );
      expect(r[3].status).toBe(1);
      expect(r[4].status).toBe(1);
      expect(r[4].apps).toBe("stopped");
      // The database is missing now: no copy is needed to drop nothing.
      expect(r[5].status, r[5].stderr).toBe(0);
      expect(r[5].db).toEqual(["up_users 3", "posts 5"]);
      expect(r[7].status, r[7].stderr).toBe(0);
    });

    it("a failed restore rolls back to an empty database; back restores the attempt's copy", () => {
      // Attempt 8 copies the database restored by attempt 0 (2 tables).
      expect(r[8].state.SAFETY_TABLES).toBe("2");
      expect(r[9].status).toBe(1);
      expect(stopLine(r[9])).toContain(
        "pg_restore failed and rolled back: the database is empty; to go back: infra/restore-db.sh back",
      );
      expect(r[9].db).toEqual([]);
      expect(r[9].apps).toBe("stopped");
      expect(r[10].status, r[10].stderr).toBe(0);
      expect(r[10].stdout).toContain(
        `back: the database as it was before attempt ${r[8].state.ATTEMPT}, ${copyOf(r[8], r[8].state.ATTEMPT)}`,
      );
      expect(r[10].state.SOURCE).toBe(copyOf(r[8], r[8].state.ATTEMPT));
      expect(r[10].state.BACK_OF).toBe(r[8].state.ATTEMPT);
      // The way back copies the empty database, too, but keeps leading to attempt 8's copy.
      expect(r[10].state.SAFETY_TABLES).toBe("0");
      expect(r[10].state.ORIGIN_ATTEMPT).toBe(r[8].state.ATTEMPT);
    });

    it("a failed way back goes back again to the same copy, not to the copy of the empty database", () => {
      // The pasted functions' way back took the copy the last prepare printed:
      // after a failed way back that is the empty database's.
      expect(r[11].status).toBe(1);
      expect(r[12].status, r[12].stderr).toBe(0);
      expect(r[12].state.SOURCE).toBe(copyOf(r[8], r[8].state.ATTEMPT));
      expect(r[13].status, r[13].stderr).toBe(0);
      expect(r[13].db).toEqual(["up_users 3", "posts 5"]);
      expect(r[14].status, r[14].stderr).toBe(0);
      expect(r[15].status, r[15].stderr).toBe(0);
      expect(r[15].apps).toBe("running");
    });
  },
);

describe.skipIf(!FAST)(
  `restore-db.sh: no copy only for a database that is missing at apply${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { before: 'rm -rf "$T/db"', args: ["prepare", "good.dump"] },
          // A database appears between prepare and apply.
          /* 1 */ {
            before: 'mkdir "$T/db"; printf \'up_users 7\\nrsvps 1\\n\' > "$T/db/tables"',
            args: ["apply"],
          },
          /* 2 */ { before: 'rm -rf "$T/db"', args: ["apply"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("a database that exists at apply is dropped only with a copy prepare took", () => {
      // Before the review fix SAFETY=none skipped every check before dropdb.
      expect(r[0].status, r[0].stderr).toBe(0);
      expect(r[0].stdout).toContain("there is nothing to copy");
      expect(r[0].state.SAFETY).toBe("none");
      expect(r[1].status).toBe(1);
      expect(stopLine(r[1])).toBe(
        "STOP: the database of project infra exists now, but prepare found none and took no copy of it: run infra/restore-db.sh prepare <dump> again (it copies the database first); nothing dropped",
      );
      expect(dropped(r[1])).toBe(false);
      expect(r[1].db).toEqual(["up_users 7", "rsvps 1"]);
      expect(r[2].status, r[2].stderr).toBe(0);
    });
  },
);

describe.skipIf(!FAST)(`restore-db.sh: a state file is data to check${FAST_TITLE}`, () => {
  let r: StepReport[] = [];
  beforeAll(() => {
    const edit = (sed: string) => `sed -i '${sed}' "$S/infra.state"`;
    r = restoreSteps(
      [
        /* 0 */ { args: ["prepare", "good.dump"] },
        /* 1 */ {
          before: `cp "$S/infra.state" "$T/saved"; ${edit("s/^SAFETY=.*/SAFETY=none/")}`,
          args: ["apply"],
        },
        /* 2 */ {
          before: `cp "$T/saved" "$S/infra.state"; ${edit("s/^SAFETY=.*/SAFETY=none/; s/^SAFETY_SHA256=.*/SAFETY_SHA256=/; s/^SAFETY_TABLES=.*/SAFETY_TABLES=/")}`,
          args: ["apply"],
        },
        /* 3 */ {
          before: `cp "$T/saved" "$S/infra.state"; echo 'DUMP=/etc/passwd' >> "$S/infra.state"`,
          args: ["apply"],
        },
        /* 4 */ {
          before: `cp "$T/saved" "$S/infra.state"; ${edit("s/^DUMP_SHA256=.*/DUMP_SHA256=xyz/")}`,
          args: ["apply"],
        },
        /* 5 */ {
          before: `cp "$T/saved" "$S/infra.state"; ${edit("s/^ATTEMPT=.*/ATTEMPT=..\\/..\\/x/")}`,
          args: ["apply"],
        },
        /* 6 */ {
          before: `cp "$T/saved" "$S/infra.state"; chmod 644 "$S/infra.state"`,
          args: ["apply"],
        },
        /* 7 */ {
          before: `chmod 600 "$S/infra.state"; mv "$S/infra.state" "$T/elsewhere"; ln -s "$T/elsewhere" "$S/infra.state"`,
          args: ["status"],
        },
        /* 8 */ { before: `rm "$S/infra.state"; cp "$T/saved" "$S/infra.state"`, args: ["apply"] },
        // A setgid home (Alpine's adduser) gives the state dir mode 2700 (v0.26 fresh host).
        /* 9 */ { before: `chmod 2700 "$S"`, args: ["status"] },
      ],
      MODE as ShellMode,
    );
  }, 300_000);

  it("refuses a state file it did not write, before anything changes", () => {
    expect(stopLine(r[1])).toContain("(bad: SAFETY)");
    // A consistent SAFETY=none while the database exists is the missing-copy case.
    expect(stopLine(r[2])).toContain("exists now, but prepare found none and took no copy");
    expect(stopLine(r[3])).toContain("is not one this script wrote (line 'DUMP')");
    expect(stopLine(r[4])).toContain("(bad: DUMP_SHA256)");
    expect(stopLine(r[5])).toContain("(bad: ATTEMPT)");
    expect(stopLine(r[6])).toContain("is not mode 600 and owned by uid");
    expect(stopLine(r[7])).toContain("is not a regular file");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(r[n].status, `step ${n}`).toBe(1);
      expect(dropped(r[n]), `step ${n}`).toBe(false);
      expect(r[n].db, `step ${n}`).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
    }
    expect(r[8].status, r[8].stderr).toBe(0);
    expect(r[9].status, r[9].stderr).toBe(0);
    expect(stopLine(r[9])).toBe("");
  });
});

describe.skipIf(!FAST)(
  `restore-db.sh: a new dump or back while an attempt is unfinished${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { args: ["apply"] },
          /* 2 */ { args: ["prepare", "grant.dump"] },
          /* 3 */ { args: ["apply"] },
          /* 4 */ { args: ["back"] },
          /* 5 */ { args: ["apply"] },
          /* 6 */ { args: ["prepare", "good.dump"] },
          /* 7 */ { before: "STUB_CREATEDB_FAIL=1", args: ["apply"] },
          /* 8 */ { before: "STUB_CREATEDB_FAIL=", args: ["back"] },
          /* 9 */ { args: ["apply"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("an attempt restored but never started does not count: back goes to the database before it", () => {
      expect(r[1].status, r[1].stderr).toBe(0);
      expect(r[2].status, r[2].stderr).toBe(0);
      expect(r[2].stdout).toContain(
        `attempt ${r[0].state.ATTEMPT} did not finish; back from here goes to ${copyOf(r[0], r[0].state.ATTEMPT)} (the database before attempt ${r[0].state.ATTEMPT})`,
      );
      expect(r[2].state.ORIGIN_ATTEMPT).toBe(r[0].state.ATTEMPT);
      expect(r[3].status).toBe(1);
      expect(r[4].state.SOURCE).toBe(copyOf(r[0], r[0].state.ATTEMPT));
      expect(r[5].status, r[5].stderr).toBe(0);
      expect(r[5].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
    });

    it("after a failed createdb there is nothing to copy, and back still restores", () => {
      expect(r[7].status).toBe(1);
      expect(r[7].db).toBeNull();
      expect(r[8].status, r[8].stderr).toBe(0);
      expect(r[8].stdout).toContain(
        "does not exist (a createdb that failed?): there is nothing to copy",
      );
      expect(r[8].state.SAFETY).toBe("none");
      expect(okLine(r[8])).toContain("no database to copy");
      expect(r[9].status, r[9].stderr).toBe(0);
      expect(r[9].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
    });
  },
);

describe.skipIf(!FAST)(`restore-db.sh: an older dump over a newer schema${FAST_TITLE}`, () => {
  it("drops the newer tables with the database and compares with the dump's own count", () => {
    const r = restoreSteps(
      [
        {
          before:
            "printf 'up_users 4\\nposts 9\\nrsvps 2\\nacks 7\\ntokens 1\\n' > \"$T/db/tables\"",
          args: ["prepare", "good.dump"],
        },
        { args: ["apply"] },
        { args: ["back"] },
        { args: ["apply"] },
      ],
      MODE as ShellMode,
    );
    expect(r[0].state.SAFETY_TABLES).toBe("5");
    expect(r[1].status, r[1].stderr).toBe(0);
    expect(r[1].db).toEqual(["up_users 3", "posts 5"]);
    // The way back compares with the copy's count, not the older dump's.
    expect(r[3].status, r[3].stderr).toBe(0);
    expect(okLine(r[3])).toContain("restored 5 tables (the dump has 5) and 4 users");
  }, 300_000);
});

describe.skipIf(!FAST)(`restore-db.sh: JWT_SECRET${FAST_TITLE}`, () => {
  let r: StepReport[] = [];
  beforeAll(() => {
    r = restoreSteps(
      [
        /* 0 */ { args: ["prepare", "good.dump"] },
        /* 1 */ { args: ["apply"] },
        /* 2 */ { args: ["rotate-jwt"], env: { JWT_SECRET: "exported-value" } },
        /* 3 */ {
          before: "printf 'JWT_SECRET=second\\n' >> \"$REPO/infra/.env\"",
          args: ["rotate-jwt"],
        },
        /* 4 */ {
          before:
            "sed -i '$d' \"$REPO/infra/.env\"; printf 'services:\\n  cms:\\n    environment:\\n      JWT_SECRET: pinned-by-override\\n' > \"$REPO/infra/docker-compose.traefik.yml\"",
          args: ["rotate-jwt"],
        },
        /* 5 */ { args: ["start"] },
        /* 6 */ {
          before: ': > "$REPO/infra/docker-compose.traefik.yml"',
          args: ["rotate-jwt"],
          xtrace: true,
        },
        /* 7 */ { args: ["start"], env: { JWT_SECRET: "exported-value" } },
        /* 8 */ { before: "export SHELLOPTS", args: ["start"], xtrace: true },
      ],
      MODE as ShellMode,
    );
  }, 300_000);

  it("refuses an exported JWT_SECRET and leaves infra/.env alone", () => {
    expect(r[2].status).toBe(1);
    expect(stopLine(r[2])).toContain(
      "JWT_SECRET is exported in this shell, and Compose would hand it to the cms instead of infra/.env",
    );
    expect(r[2].jwt).toEqual(["old-secret"]);
  });

  it("refuses an infra/.env with two JWT_SECRET= lines and writes nothing", () => {
    expect(r[3].status).toBe(1);
    expect(stopLine(r[3])).toContain(
      "needs exactly one JWT_SECRET= line (it has 2); nothing written",
    );
    expect(r[3].jwt).toEqual(["old-secret", "second"]);
  });

  it("a compose file that pins the cms's JWT_SECRET fails the rotation, and start refuses", () => {
    expect(r[4].status).toBe(1);
    expect(stopLine(r[4])).toContain("but Compose hands the cms another value or none");
    expect(r[4].jwt[0]).not.toBe("old-secret");
    expect(r[4].state.ROTATED_SUM).toBe("");
    expect(r[5].status).toBe(1);
    expect(r[5].apps).toBe("stopped");
  });

  it("under bash -x the trace shows no secret", () => {
    expect(r[6].status, r[6].stderr).toBe(0);
    const secret = r[6].jwt[0];
    expect(r[6].stderr).not.toContain(secret);
    expect(r[6].stderr.trim()).toBe("+ set +x");
  });

  it("start refuses a JWT_SECRET exported after the rotation; an inherited xtrace shows nothing", async () => {
    expect(r[7].status).toBe(1);
    expect(r[7].apps).toBe("stopped");
    expect(r[8].status, r[8].stderr).toBe(0);
    expect(r[8].startedJwtSum).toBe(await sha256(r[6].jwt[0]));
    expect(r[8].stderr).not.toContain(r[6].jwt[0]);
  });
});

describe.skipIf(!FAST)(`restore-db.sh: the reservation and cancel${FAST_TITLE}`, () => {
  let r: StepReport[] = [];
  beforeAll(() => {
    r = restoreSteps(
      [
        /* 0 */ { args: ["cancel"] },
        /* 1 */ { args: ["prepare", "good.dump"] },
        /* 2 */ { args: ["cancel"] },
        /* 3 */ { args: ["apply"] },
        /* 4 */ { args: ["prepare", "good.dump"] },
        /* 5 */ { args: ["apply"] },
        /* 6 */ { args: ["cancel"] },
        /* 7 */ { before: "STUB_PGDUMP_FAIL=1", args: ["prepare", "good.dump"] },
        /* 8 */ { before: "STUB_PGDUMP_FAIL=", args: ["cancel"] },
        /* 9 */ { args: ["back"] },
        /* 10 */ { args: ["apply"] },
        /* 11 */ { args: ["rotate-jwt"] },
        /* 12 */ { args: ["start"] },
      ],
      MODE as ShellMode,
    );
  }, 300_000);

  it("cancel needs a reservation", () => {
    expect(r[0].status).toBe(1);
    expect(stopLine(r[0])).toBe(
      "STOP: compose project infra has no restore reservation; nothing to cancel",
    );
  });

  it("cancel before apply ends the attempt and the reservation, and drops or starts nothing", () => {
    expect(r[1].reserved).toBe(true);
    expect(r[2].status, r[2].stderr).toBe(0);
    expect(okLine(r[2])).toContain(
      `OK: restore of compose project infra cancelled (attempt ${r[1].state.ATTEMPT}): nothing was dropped or started, and infra/deploy.sh may deploy again. Web and cms stay as they are (prepare stopped them); to start them: docker compose -p infra -f ${r[1].checkout}/infra/docker-compose.yml -f ${r[1].checkout}/infra/docker-compose.traefik.yml up -d --no-build web cms`,
    );
    expect(r[2].reserved).toBe(false);
    expect(r[2].stages).toEqual([]);
    expect(r[2].state.CANCELLED_AT).not.toBe("");
    expect(r[2].apps).toBe("stopped");
    expect(r[2].calls.filter((c) => c.includes(" up ") || c.includes("dropdb"))).toEqual([]);
    expect(r[3].status).toBe(1);
    expect(stopLine(r[3])).toContain("was ended at ");
  });

  it("cancel refuses once apply has begun; a failed prepare keeps the reservation", () => {
    expect(r[5].status, r[5].stderr).toBe(0);
    expect(r[6].status).toBe(1);
    expect(stopLine(r[6])).toContain("apply began at ");
    expect(r[6].reserved).toBe(true);
    expect(r[7].status).toBe(1);
    expect(r[7].reserved).toBe(true);
    // Attempt 4 began its apply: a failed prepare does not make it cancellable.
    expect(r[8].status).toBe(1);
    expect(r[9].status, r[9].stderr).toBe(0);
    expect(r[12].status, r[12].stderr).toBe(0);
    expect(r[12].reserved).toBe(false);
  });
});

describe.skipIf(!FAST)(
  `restore-db.sh: once an apply began, only a passing start ends the reservation${FAST_TITLE}`,
  () => {
    let a: StepReport[] = [];
    let b: StepReport[] = [];
    beforeAll(() => {
      a = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { before: "STUB_RESTORE_FAIL=1", args: ["apply"] },
          /* 2 */ { before: "STUB_RESTORE_FAIL=", args: ["back"] },
          /* 3 */ { args: ["cancel"] },
          /* 4 */ { args: ["status"] },
          /* 5 */ { args: ["apply"] },
          /* 6 */ { args: ["rotate-jwt"] },
          /* 7 */ { args: ["start"] },
          /* 8 */ { args: ["prepare", "good.dump"] },
          /* 9 */ { args: ["cancel"] },
          /* 10 */ { args: ["prepare", "good.dump"] },
          /* 11 */ { before: 'rm "$S/infra.reservation"', args: ["apply"] },
        ],
        MODE as ShellMode,
      );
      b = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { args: ["apply"] },
          /* 2 */ { args: ["prepare", "older.dump"] },
          /* 3 */ { args: ["cancel"] },
          /* 4 */ { args: ["start", "--env-only"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("a failed apply marks the database unsafe; a passing back does not clear it, so cancel refuses", () => {
      // Before round 2 the back attempt had no apply of its own, cancel passed,
      // dropped the reservation and let a deploy start the cms on the empty database.
      expect(a[0].reservation.UNSAFE_SINCE).toBe("");
      expect(a[1].status).toBe(1);
      expect(a[1].reservation.UNSAFE_SINCE).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(a[1].reservation.UNSAFE_ATTEMPT).toBe(a[0].state.ATTEMPT);
      expect(a[2].status, a[2].stderr).toBe(0);
      expect(a[2].reservation.UNSAFE_SINCE).toBe(a[1].reservation.UNSAFE_SINCE);
      expect(a[2].reservation.ATTEMPT).toBe(a[2].state.ATTEMPT);
      expect(a[3].status).toBe(1);
      expect(stopLine(a[3])).toBe(
        `STOP: an apply began at ${a[1].reservation.UNSAFE_SINCE} (attempt ${a[0].state.ATTEMPT}) and no start has passed since: the database may be empty, half-restored or restored without its new JWT_SECRET, so cancel refuses; finish with apply, rotate-jwt and start, or go back with back, then apply, rotate-jwt and start; nothing changed`,
      );
      expect(a[3].reserved).toBe(true);
      expect(a[4].stdout).toContain(
        `unsafe:    since ${a[1].reservation.UNSAFE_SINCE}, when the apply of attempt ${a[0].state.ATTEMPT} began`,
      );
    });

    it("a start that passes ends the mark with the reservation; a later prepare can be cancelled again", () => {
      for (const n of [5, 6, 7]) expect(a[n].status, `step ${n}: ${a[n].stderr}`).toBe(0);
      expect(a[7].reserved).toBe(false);
      expect(a[8].reservation.UNSAFE_SINCE).toBe("");
      expect(a[9].status, a[9].stderr).toBe(0);
      expect(a[9].reserved).toBe(false);
    });

    it("apply refuses when the reservation is gone", () => {
      expect(a[11].status).toBe(1);
      expect(stopLine(a[11])).toContain("is gone (infra/deploy.sh would deploy meanwhile)");
      expect(dropped(a[11])).toBe(false);
    });

    it("an apply that passed but was never rotated and started keeps the mark through another prepare", () => {
      expect(b[1].status, b[1].stderr).toBe(0);
      expect(b[2].status, b[2].stderr).toBe(0);
      expect(b[2].reservation.UNSAFE_ATTEMPT).toBe(b[0].state.ATTEMPT);
      expect(b[3].status).toBe(1);
      expect(stopLine(b[3])).toContain("so cancel refuses");
      expect(b[3].reserved).toBe(true);
      expect(b[4].status).toBe(1);
      expect(b[4].apps).toBe("stopped");
    });
  },
);

describe.skipIf(!FAST)(
  `restore-db.sh: a start whose cleanup did not finish is finished by start${FAST_TITLE}`,
  () => {
    let a: StepReport[] = [];
    let b: StepReport[] = [];
    beforeAll(() => {
      const stage = '"$REPO"/infra/backups/restore-*';
      a = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { args: ["apply"] },
          /* 2 */ { args: ["rotate-jwt"] },
          // The staged dump cannot be removed (its directory is not writable).
          /* 3 */ { before: `chmod 500 ${stage}; STUB_RM_AS_USER=1`, args: ["start"] },
          /* 4 */ { args: ["cancel"] },
          /* 5 */ { args: ["status"] },
          /* 6 */ { before: `chmod 700 ${stage}; STUB_RM_AS_USER=`, args: ["start"] },
          /* 7 */ { args: ["start"] },
          /* 8 */ { args: ["prepare", "good.dump"] },
          /* 9 */ { args: ["apply"] },
          /* 10 */ { args: ["rotate-jwt"] },
          // Interrupted right after STARTED_AT was saved.
          /* 11 */ { before: "STUB_KILL_AFTER_STARTED=1", args: ["start"] },
          /* 12 */ { before: "STUB_KILL_AFTER_STARTED=", args: ["start"] },
        ],
        MODE as ShellMode,
      );
      b = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { args: ["apply"] },
          /* 2 */ { args: ["rotate-jwt"] },
          /* 3 */ { before: `chmod 500 ${stage}; STUB_RM_AS_USER=1`, args: ["start"] },
          // A later prepare that fails after it reserved anew (the apps stop again).
          /* 4 */ {
            before: `chmod 700 ${stage}; STUB_RM_AS_USER=; STUB_PGDUMP_FAIL=1`,
            args: ["prepare", "older.dump"],
          },
          /* 5 */ { before: "STUB_PGDUMP_FAIL=", args: ["start"] },
          /* 6 */ { args: ["cancel"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("a cleanup that fails after the apps started leaves a start that finishes it", () => {
      // Before round 3 the attempt counted as started, start refused, and the
      // unsafe mark made cancel refuse too: deploys stayed blocked.
      expect(a[3].status).toBe(1);
      expect(a[3].apps).toBe("running");
      expect(a[3].state.STARTED_AT).not.toBe("");
      expect(stopLine(a[3])).toContain("removing the staged dump ");
      expect(stopLine(a[3])).toContain(
        "its cleanup did not finish: fix the cause, then run infra/restore-db.sh start again, which finishes only the cleanup",
      );
      expect(a[3].reserved).toBe(true);
      expect(a[4].status).toBe(1);
      expect(a[5].stdout).toContain(`started:   ${a[3].state.STARTED_AT}`);
      expect(a[6].status, a[6].stderr).toBe(0);
      expect(okLine(a[6])).toContain(
        `OK: attempt ${a[0].state.ATTEMPT} complete: web and cms were started at ${a[3].state.STARTED_AT}; its cleanup is finished now`,
      );
      // Only the cleanup: no compose call, the database and the containers untouched.
      expect(a[6].calls).toEqual([]);
      expect(a[6].reserved).toBe(false);
      expect(a[6].stages).toEqual([]);
      expect(a[7].status).toBe(1);
    });

    it("an interruption right after STARTED_AT was saved is finished by start", () => {
      expect(a[11].status).toBe(143);
      expect(stopLine(a[11])).toContain("STOP: start interrupted; ");
      expect(a[11].state.STARTED_AT).not.toBe("");
      expect(a[11].reserved).toBe(true);
      expect(a[11].stages).toHaveLength(1);
      expect(a[12].status, a[12].stderr).toBe(0);
      expect(okLine(a[12])).toContain("its cleanup is finished now");
      expect(a[12].calls).toEqual([]);
      expect(a[12].reserved).toBe(false);
      expect(a[12].stages).toEqual([]);
    });

    it("a reservation of a later prepare stays: only the started attempt's mark goes", () => {
      expect(b[3].status).toBe(1);
      expect(b[4].status).toBe(1);
      expect(b[4].reservation.UNSAFE_ATTEMPT).toBe(b[0].state.ATTEMPT);
      expect(b[5].status, b[5].stderr).toBe(0);
      expect(b[5].stdout).toContain(
        `the reservation belongs to attempt ${b[4].reservation.ATTEMPT} (a later prepare): it stays; the unsafe mark of attempt ${b[0].state.ATTEMPT} is gone`,
      );
      expect(b[5].reserved).toBe(true);
      expect(b[5].reservation.UNSAFE_SINCE).toBe("");
      // That prepare's apply never began: it can be cancelled.
      expect(b[6].status, b[6].stderr).toBe(0);
      expect(b[6].reserved).toBe(false);
    });
  },
);

describe.skipIf(!FAST)(
  `restore-db.sh: order, the env-only pair, the lock and the compose files${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    const baseOnly = "$REPO/infra/docker-compose.yml";
    /** As an app started with a legacy-zone override before v0.25 (retired in v0.29). */
    const retired = "$REPO/infra/docker-compose.yml,$REPO/infra/docker-compose.cms-legacy-tz.yml";
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { args: ["start"] },
          /* 1 */ { args: ["rotate-jwt"] },
          /* 2 */ { args: ["start", "--env-only"] },
          /* 3 */ { args: ["rotate-jwt", "--env-only"] },
          /* 4 */ { before: "STUB_SITE_ALLOW=203.0.113.7/32", args: ["start", "--env-only"] },
          /* 5 */ { before: "STUB_SITE_ALLOW=", args: ["start", "--env-only"] },
          /* 6 */ { args: ["prepare", "good.dump"] },
          /* 7 */ { args: ["start"] },
          /* 8 */ { args: ["apply"] },
          /* 9 */ { args: ["rotate-jwt", "--env-only"] },
          /* 10 */ { args: ["start", "--env-only"] },
          /* 11 */ { args: ["start"] },
          /* 12 */ { before: "STUB_LOCK_HELD=1", args: ["rotate-jwt"] },
          /* 13 */ {
            before: `STUB_LOCK_HELD=; STUB_LABEL_WEB="${baseOnly}" STUB_LABEL_CMS="${baseOnly}"`,
            args: ["rotate-jwt"],
          },
          /* 14 */ {
            before: `STUB_LABEL_WEB="${TRAEFIK_LABEL}" STUB_LABEL_CMS="${TRAEFIK_LABEL}"`,
            args: ["rotate-jwt", "--env-only"],
          },
          /* 15 */ {
            before:
              'STUB_LABEL_WEB="$REPO/infra/docker-compose.yml,/tmp/cms-direct-start.yml" STUB_LABEL_CMS="$STUB_LABEL_WEB"',
            args: ["rotate-jwt", "--env-only"],
          },
          /* 16 */ {
            before: `STUB_LABEL_WEB="${TRAEFIK_LABEL}" STUB_LABEL_CMS="$REPO/infra/docker-compose.yml"`,
            args: ["rotate-jwt", "--env-only"],
          },
          /* 17 */ {
            before: "STUB_LABEL_WEB= STUB_LABEL_CMS= STUB_LABEL_DB=",
            args: ["rotate-jwt", "--env-only"],
          },
          /* 18 */ {
            args: ["rotate-jwt", "--env-only"],
            env: { RESTORE_COMPOSE_FILES: "infra/docker-compose.yml" },
          },
          /* 19 */ { args: ["prepare"] },
          /* 20 */ { args: ["rotate-jwt", "--now"] },
          /* 21 */ { args: ["status"], env: { COMPOSE_PROJECT: "staging" } },
          /* 22 */ {
            before: `STUB_LABEL_WEB="${retired}" STUB_LABEL_CMS="${retired}"`,
            args: ["rotate-jwt", "--env-only"],
          },
          /* 23 */ {
            args: ["rotate-jwt", "--env-only"],
            env: {
              RESTORE_COMPOSE_FILES:
                "infra/docker-compose.yml:infra/docker-compose.web-legacy-tz.yml",
            },
          },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("refuses every step before its turn", () => {
      expect(stopLine(r[0])).toBe(
        "STOP: web and cms not started (attempt none: restored no, JWT_SECRET rotated no, started no)",
      );
      expect(stopLine(r[1])).toContain("apply did not pass for the current attempt (none)");
      expect(stopLine(r[2])).toContain("rotate-jwt --env-only did not pass");
      for (const n of [0, 1, 2, 7, 11]) expect(r[n].status, `step ${n}`).toBe(1);
      expect(r[0].jwt).toEqual(["old-secret"]);
    });

    it("the env-only pair rotates and starts once", () => {
      expect(r[3].status, r[3].stderr).toBe(0);
      expect(okLine(r[3])).toContain("JWT_SECRET rotated (infra/.env only)");
      expect(r[4].status, r[4].stderr).toBe(0);
      expect(r[4].apps).toBe("running");
      expect(r[4].envOnly.STARTED_AT).not.toBe("");
      // Closed at the edge (SITE_ALLOW_CIDRS): no reminder.
      expect(r[4].stdout).not.toContain("The site will be public");
      expect(r[5].status).toBe(1);
    });

    it("start --env-only is refused while a restore holds the reservation", () => {
      expect(r[8].status, r[8].stderr).toBe(0);
      expect(r[9].status, r[9].stderr).toBe(0);
      expect(r[10].status).toBe(1);
      expect(stopLine(r[10])).toContain(
        `a database restore of compose project infra holds the reservation (attempt ${r[6].state.ATTEMPT})`,
      );
      expect(r[10].apps).toBe("stopped");
    });

    it("a held lock stops the step with exit 3 before anything", () => {
      expect(r[12].status).toBe(3);
      expect(stopLine(r[12])).toMatch(
        /^STOP: another infra\/restore-db\.sh step or infra\/deploy\.sh holds the lock of compose project infra \(\/.*\/\.git\/sinnlos-deploy\/infra\.lock\); nothing changed/,
      );
      expect(r[12].calls).toEqual([]);
    });

    it("an attempt keeps its compose files: others now are refused", () => {
      expect(r[13].status).toBe(1);
      expect(stopLine(r[13])).toContain(
        `the attempt runs with the compose files ${r[6].state.COMPOSE_FILES}, but `,
      );
    });

    it("keeps every overlay of the running containers in their order", () => {
      expect(r[14].status, r[14].stderr).toBe(0);
      const c = r[14].checkout;
      expect(r[14].envOnly.COMPOSE_FILES).toBe(
        `${c}/infra/docker-compose.yml,${c}/infra/docker-compose.traefik.yml`,
      );
      expect(r[14].calls).toContainEqual(
        `docker compose -p infra -f ${c}/infra/docker-compose.yml -f ${c}/infra/docker-compose.traefik.yml config --format json cms`,
      );
    });

    it("refuses a retired legacy-zone override, from the containers or named, saying what to do", () => {
      for (const n of [22, 23]) {
        expect(r[n].status, `step ${n}`).toBe(1);
        expect(stopLine(r[n]), `step ${n}`).toContain(
          "is a retired compose file (the legacy-zone override of releases before v0.25, gone since v0.29): recreate web and cms with the supported files first",
        );
        expect(r[n].calls, `step ${n}`).not.toContainEqual(expect.stringContaining(" config "));
      }
      expect(stopLine(r[22])).toContain("/infra/docker-compose.cms-legacy-tz.yml is a retired");
      expect(stopLine(r[23])).toContain("/infra/docker-compose.web-legacy-tz.yml is a retired");
    });

    it("refuses an unknown compose file, web and cms that differ, and containers that tell nothing", () => {
      expect(stopLine(r[15])).toContain(
        "were started with /tmp/cms-direct-start.yml, which is not a known compose file of ",
      );
      expect(stopLine(r[16])).toContain("were started with different compose files");
      expect(stopLine(r[17])).toContain(
        "do not tell their compose files (none, or several of one service): set RESTORE_COMPOSE_FILES",
      );
      for (const n of [15, 16, 17]) expect(r[n].status, `step ${n}`).toBe(1);
      // Named explicitly, the files are used as named.
      expect(r[18].status, r[18].stderr).toBe(0);
      expect(r[18].calls).toContainEqual(
        `docker compose -p infra -f ${r[18].checkout}/infra/docker-compose.yml config --format json cms`,
      );
    });

    it("usage errors exit 2; another compose project has its own (empty) state", () => {
      expect(r[19].status).toBe(2);
      expect(r[20].status).toBe(2);
      expect(r[21].status).toBe(0);
      expect(r[21].stdout).toMatch(/^no restore attempt of compose project staging \(/);
    });
  },
);

/* ------------------------------------------------------------------------ */
/* Slow: a real Postgres 16 in a throwaway compose project                   */
/* ------------------------------------------------------------------------ */

const SLOW_TITLE = RUN_SLOW
  ? ""
  : ` (skipped: set SINNLOS_SLOW_SHELL_TESTS=1 with Docker; ${skipReason([...TOOLS, "docker"])})`;

const SLOW_HARNESS = readFileSync(
  new URL("./restore-db.test-slow.sh", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function slowRun(): Map<string, string[]> {
  const script = [
    "set -uo pipefail",
    "umask 077",
    'T="$(mktemp -d)"',
    'REPO="$T/checkout"',
    'mkdir -p "$REPO/infra"',
    "cat > \"$REPO/infra/restore-db.sh\" <<'RESTORE_DB_EOF'",
    SCRIPT.trimEnd(),
    "RESTORE_DB_EOF",
    'chmod 755 "$REPO/infra/restore-db.sh"',
    SLOW_HARNESS,
  ].join("\n");
  const res = runBash(script, SLOW_MODE as ShellMode, { timeout: 900_000 });
  const out = new Map<string, string[]>();
  for (const line of res.stdout.split("\n")) {
    const m = /^@@(\S+) ?(.*)$/.exec(line);
    if (!m) continue;
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  expect(out.get("done"), `${res.stdout}\n${res.stderr}`).toEqual(["1"]);
  return out;
}

describe.skipIf(!RUN_SLOW)(`restore-db.sh against Postgres 16${SLOW_TITLE}`, () => {
  let o = new Map<string, string[]>();
  const one = (key: string) => (o.get(key) ?? [""]).join("\n");
  const stopOf = (name: string) =>
    (o.get(`${name}.err`) ?? []).find((l) => l.startsWith("STOP: ")) ?? "";
  beforeAll(() => {
    o = slowRun();
  }, 900_000);

  it("refuses a dump cut off in its data (its table of contents lists), garbage and a missing file", () => {
    expect(one("cut.list")).toBe("0");
    expect(one("cut.rc")).toBe("1");
    expect(stopOf("cut")).toContain("cut.dump is no readable dump");
    expect(one("garbage.rc")).toBe("1");
    expect(one("missing.rc")).toBe("1");
    expect(one("refused.tables")).toBe(one("start.tables"));
    expect(one("refused.running")).toBe("cms db web ");
  });

  it("restores an older dump over a newer database, rotates and starts with the new secret and every overlay", () => {
    expect(one("start.tables")).toBe("3");
    expect(one("start.tz")).toBe("Europe/Berlin");
    for (const step of ["b.prepare", "b.apply", "b.rotate", "b.start"]) {
      expect(one(`${step}.rc`), `${step}: ${one(`${step}.err`)}`).toBe("0");
    }
    expect(one("b.tables")).toBe("2");
    expect(one("b.users")).toBe("3");
    expect(one("b.running")).toBe("cms db web ");
    expect(one("b.envsum")).not.toBe(one("start.envsum"));
    // The running cms container holds the rotated secret, and its legacy-zone overlay.
    expect(one("b.cmssum")).toBe(one("b.envsum"));
    expect(one("b.tz")).toBe("Europe/Berlin");
  });

  it("restores the staged dump although the path given to prepare leads elsewhere by then", () => {
    for (const step of ["s.prepare", "s.apply", "s.rotate", "s.start"]) {
      expect(one(`${step}.rc`), `${step}: ${one(`${step}.err`)}`).toBe("0");
    }
    // The symlink pointed at the dump that fails to restore when apply ran.
    expect(one("s.tables")).toBe("2");
  });

  it("a failed createdb leaves no database and no start; apply again restores", () => {
    expect(one("c.apply.rc")).toBe("1");
    expect(stopOf("c.apply")).toContain("createdb failed: it does not exist now");
    expect(one("c.exists")).toBe("0");
    expect(one("c.start.rc")).toBe("1");
    expect(one("c.apply2.rc"), one("c.apply2.err")).toBe("0");
    expect(one("c.tables")).toBe("2");
  });

  it("a failed restore rolls back to an empty database, and back restores the copy", () => {
    expect(one("d.apply.rc")).toBe("1");
    expect(stopOf("d.apply")).toContain("pg_restore failed and rolled back");
    expect(one("d1.tables")).toBe("0");
    expect(one("d1.running")).toBe("db ");
    for (const step of ["d.back", "d.apply2", "d.rotate", "d.start"]) {
      expect(one(`${step}.rc`), `${step}: ${one(`${step}.err`)}`).toBe("0");
    }
    expect(one("d2.tables")).toBe("2");
    expect(one("d2.users")).toBe("3");
    expect(one("d2.cmssum")).toBe(one("d2.envsum"));
  });

  it("an override that pins JWT_SECRET and an exported one are refused; the env-only pair works", () => {
    expect(one("e.pinned.rc")).toBe("1");
    expect(one("e.pinned.err")).toContain("Compose hands the cms another value or none");
    expect(one("e.rotate.rc"), one("e.rotate.err")).toBe("0");
    expect(one("e.exported.rc")).toBe("1");
    expect(one("e.start.rc"), one("e.start.err")).toBe("0");
    expect(one("e.cmssum")).toBe(one("e.envsum"));
    expect(one("e.envsum")).not.toBe(one("d2.envsum"));
  });

  it("a step while another process holds the deploy lock exits 3 and changes nothing", () => {
    expect(one("f.locked.rc")).toBe("3");
    expect(stopOf("f.locked")).toContain("holds the lock of compose project rs-restore-");
    expect(one("f.running")).toBe("cms db web ");
  });
});
