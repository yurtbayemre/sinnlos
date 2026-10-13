/**
 * infra/restore-db.sh: the database restore of docs/DEPLOYMENT.md §7.1 as a
 * script with an on-disk attempt state. Pinned:
 *   1. a dump must list at least one table AND decode to the end before
 *      anything changes; web and cms stop, and a NEW copy of the database
 *      (never overwritten, checked the same way) exists before any drop;
 *   2. apply drops only for a prepared attempt whose dump and copy still
 *      have the sha256 of prepare and decode; it restores into a clean
 *      database in one transaction and requires the dump's tables and a
 *      user; a failed createdb or restore can be retried, and `back`
 *      returns to the database from before the restore, also after a
 *      failed way back;
 *   3. rotate-jwt refuses an exported JWT_SECRET and an .env without
 *      exactly one JWT_SECRET= line, writes a fresh value (mode 600) and
 *      passes only when Compose hands the cms that value; no secret in any
 *      output, also under bash -x;
 *   4. start needs apply and rotate-jwt of the same attempt (or the
 *      --env-only pair, refused while a database restore is unfinished)
 *      and the rotated secret still effective; it uses the attempt up;
 *   5. one step at a time per compose project (the deploy lock); the
 *      compose files are the project's (Traefik overlay or not), the same
 *      for every step of an attempt.
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
const TOOLS = ["flock", "openssl", "git", "sha256sum", "stat", "mktemp", "awk", "sed"];
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
  });

  it("restores into a clean database in one transaction that stops at the first error", () => {
    expect(SCRIPT).toContain(
      `'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'`,
    );
    expect(SCRIPT).toContain(
      `'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction'`,
    );
    expect(SCRIPT).not.toMatch(/pg_restore[^\n]*--clean/);
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
  /** Files in infra/backups. */
  backups: string[];
  /** Archived attempt states (<project>.<attempt>.state). */
  archived: number;
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

/**
 * Runs the steps in one bash process, in a fresh checkout ($REPO, a git
 * repo) with the real restore-db.sh, an infra/.env (JWT_SECRET=old-secret)
 * and a database of three tables (up_users 3, posts 5, rsvps 2). Fake dumps
 * in $T: good.dump (up_users, posts), cut.dump (good.dump without its end),
 * garbage.dump, grant.dump (fails to restore), nousers.dump.
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
    ': > "$REPO/infra/docker-compose.yml"; : > "$REPO/infra/docker-compose.traefik.yml"',
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
    "STEP_CWD=",
    "export T REPO STUB_EDGE=traefik STUB_STOP_FAIL= STUB_UP_FAIL= STUB_PGDUMP_FAIL= STUB_CREATEDB_FAIL= STUB_RESTORE_FAIL= STUB_LOCK_HELD=",
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
      'S="$REPO/.git/sinnlos-restore"',
      'if [[ -f "$S/infra.state" ]]; then sed "s/^/@@STATE /" "$S/infra.state"; fi',
      'if [[ -f "$S/infra.env-only.state" ]]; then sed "s/^/@@ENVONLY /" "$S/infra.env-only.state"; fi',
      'if [[ -d "$T/db" ]]; then echo "@@DBEXISTS"; sed "s/^/@@DB /" "$T/db/tables"; fi',
      'sed -n "s/^JWT_SECRET=/@@JWT /p" "$REPO/infra/.env" 2>/dev/null',
      'echo "@@ENVMODE $(stat -c %a "$REPO/infra/.env" 2>/dev/null)"',
      'echo "@@STARTED $(cat "$T/started-jwt" 2>/dev/null)"',
      'echo "@@APPS $(cat "$T/apps")"',
      'for f in "$REPO"/infra/backups/*; do if [[ -e "$f" ]]; then echo "@@BACKUP ${f##*/}"; fi; done',
      'echo "@@ARCHIVED $(ls "$S" 2>/dev/null | grep -c "^infra\\.[0-9].*\\.state$")"',
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
        archived: 0,
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
    else if (tag === "@@ARCHIVED") current.archived = Number(value);
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

  it("prepare checks the dump, stops the apps and writes a new, checked copy; it drops nothing", () => {
    expect(r[0].status, r[0].stderr).toBe(0);
    expect(okLine(r[0])).toMatch(
      /^OK: attempt \d{8}T\d{6}Z-[0-9a-f]{4}: \/.*\/good\.dump holds 2 tables; web and cms stopped; the current database \(3 tables\) is saved in \/.*\/infra\/backups\/before-restore-\d{8}T\d{6}Z-[0-9a-f]{4}\.dump\. Next: infra\/restore-db\.sh apply$/,
    );
    expect(r[0].apps).toBe("stopped");
    expect(dropped(r[0])).toBe(false);
    expect(r[0].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
    expect(r[0].backups).toEqual([`before-restore-${r[0].state.ATTEMPT}.dump`]);
    // The dump is checked in full (list and decode), and so is the copy.
    expect(r[0].calls.filter((c) => c.endsWith("exec -T db pg_restore --list"))).toHaveLength(2);
    expect(
      r[0].calls.filter((c) => c.endsWith("exec -T db pg_restore --file=/dev/null")),
    ).toHaveLength(2);
    // The Traefik overlay of the project's containers is used.
    expect(r[0].calls.find((c) => c.includes(" stop web cms"))).toMatch(
      /^docker compose -p infra -f \/.*\/infra\/docker-compose\.yml -f \/.*\/infra\/docker-compose\.traefik\.yml stop web cms$/,
    );
  });

  it("records the attempt on disk: dump and copy with their sha256 and table counts", () => {
    const s = r[0].state;
    expect(s.PROJECT).toBe("infra");
    expect(s.EDGE).toBe("traefik");
    expect(s.DUMP).toMatch(/\/good\.dump$/);
    expect(s.DUMP_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.DUMP_TABLES).toBe("2");
    expect(s.SAFETY).toMatch(new RegExp(`/infra/backups/before-restore-${s.ATTEMPT}\\.dump$`));
    expect(s.SAFETY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.SAFETY_TABLES).toBe("3");
    expect(s.ORIGIN).toBe(s.SAFETY);
    expect(s.PREPARED_AT).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(s.APPLY_STARTED_AT).toBe("");
    expect(r[1].stdout).toContain(
      `attempt ${s.ATTEMPT} of compose project infra (traefik compose files`,
    );
    expect(r[1].stdout).toContain("next:      infra/restore-db.sh apply");
  });

  it("apply restores into a clean database and checks tables and users", () => {
    expect(r[2].status, r[2].stderr).toBe(0);
    expect(okLine(r[2])).toBe(
      `OK: attempt ${r[0].state.ATTEMPT}: restored 2 tables (the dump has 2) and 3 users into a clean database. Next: infra/restore-db.sh rotate-jwt`,
    );
    expect(r[2].db).toEqual(["up_users 3", "posts 5"]);
    const drop = r[2].calls.findIndex((c) => c.includes("dropdb"));
    const restore = r[2].calls.findIndex((c) => c.includes("--single-transaction"));
    const stop = r[2].calls.findIndex((c) => c.endsWith(" stop web cms"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(drop);
    expect(drop).toBeLessThan(restore);
    expect(r[2].state.APPLIED_AT).not.toBe("");
    expect(r[2].state.RESTORED_TABLES).toBe("2");
    expect(r[2].state.USERS).toBe("3");
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

  it("start brings web and cms up with the rotated secret and uses the attempt up", async () => {
    expect(r[4].status, r[4].stderr).toBe(0);
    expect(r[4].apps).toBe("running");
    expect(r[4].startedJwtSum).toBe(await sha256(r[3].jwt[0]));
    expect(r[4].calls).toContainEqual(expect.stringMatching(/ up -d --no-build web cms$/));
    expect(r[4].state.STARTED_AT).not.toBe("");
    expect(r[5].stdout).toContain("next:      nothing (done); another restore starts with prepare");
    expect(r[6].status).toBe(1);
    expect(r[7].status).toBe(1);
    expect(stopLine(r[7])).toContain("is used up");
    expect(dropped(r[7])).toBe(false);
  });

  it("back after a finished restore prepares the copy taken before it", () => {
    expect(r[8].status, r[8].stderr).toBe(0);
    expect(r[8].state.DUMP).toBe(r[0].state.SAFETY);
    expect(r[8].state.DUMP_TABLES).toBe("3");
    expect(r[8].state.BACK_OF).toBe(r[0].state.ATTEMPT);
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
  `restore-db.sh: the copy and the dump between prepare and apply${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { args: ["prepare", "good.dump"] },
          /* 1 */ { before: 'rm "$REPO"/infra/backups/before-restore-*.dump', args: ["apply"] },
          /* 2 */ { args: ["prepare", "good.dump"] },
          /* 3 */ {
            before: 'printf x >> "$(ls "$REPO"/infra/backups/before-restore-*.dump)"',
            args: ["apply"],
          },
          /* 4 */ { args: ["prepare", "good.dump"] },
          /* 5 */ { before: 'echo "table extra 1" >> "$T/good.dump"', args: ["apply"] },
          /* 6 */ {
            before: fakeDump("good.dump", ["up_users 3", "posts 5"]),
            args: ["prepare", "good.dump"],
          },
          /* 7 */ { before: 'STEP_CWD="$REPO/infra"', args: ["apply"] },
          /* 8 */ { before: "STEP_CWD=; STUB_PGDUMP_FAIL=1", args: ["prepare", "good.dump"] },
          /* 9 */ { before: "STUB_PGDUMP_FAIL=", args: ["status"] },
        ],
        MODE as ShellMode,
      );
    }, 300_000);

    it("a deleted or changed copy stops apply before the drop", () => {
      expect(r[1].status).toBe(1);
      expect(stopLine(r[1])).toContain(
        "is gone or changed since prepare; nothing dropped (start again with prepare",
      );
      expect(dropped(r[1])).toBe(false);
      expect(r[3].status).toBe(1);
      expect(stopLine(r[3])).toContain("is gone or changed since prepare");
      expect(dropped(r[3])).toBe(false);
      expect(r[3].db).toEqual(["up_users 3", "posts 5", "rsvps 2"]);
    });

    it("a changed dump stops apply before the drop", () => {
      expect(r[5].status).toBe(1);
      expect(stopLine(r[5])).toContain("good.dump is gone or changed since prepare");
      expect(dropped(r[5])).toBe(false);
    });

    it("each prepare writes a new copy and keeps the earlier ones", () => {
      expect(r[6].backups).toHaveLength(3);
      expect(new Set(r[6].backups).size).toBe(3);
      expect(r[6].archived).toBe(3);
      // The dump path is absolute in the state: another working directory finds it.
      expect(r[7].status, r[7].stderr).toBe(0);
    });

    it("a failing pg_dump leaves no copy and no attempt behind; the last attempt stays current", () => {
      expect(r[8].status).toBe(1);
      expect(stopLine(r[8])).toBe(
        "STOP: no usable copy of the current database (pg_dump or its check failed); web and cms are stopped, nothing dropped",
      );
      expect(r[8].backups).toHaveLength(3);
      expect(r[8].state.ATTEMPT).toBe(r[6].state.ATTEMPT);
      expect(r[9].stdout).toContain(`attempt ${r[6].state.ATTEMPT}`);
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
        "next:      the apply did not pass, the database may be empty: apply again, or back",
      );
      expect(r[3].status).toBe(1);
      expect(r[4].status).toBe(1);
      expect(r[4].apps).toBe("stopped");
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
        `back: the database as it was before attempt ${r[8].state.ATTEMPT}, ${r[8].state.SAFETY}`,
      );
      expect(r[10].state.DUMP).toBe(r[8].state.SAFETY);
      expect(r[10].state.BACK_OF).toBe(r[8].state.ATTEMPT);
      // The way back copies the empty database, too, but keeps leading to attempt 8's copy.
      expect(r[10].state.SAFETY_TABLES).toBe("0");
      expect(r[10].state.ORIGIN).toBe(r[8].state.SAFETY);
    });

    it("a failed way back goes back again to the same copy, not to the copy of the empty database", () => {
      // The pasted functions' way back took the copy the last prepare printed:
      // after a failed way back that is the empty database's.
      expect(r[11].status).toBe(1);
      expect(r[12].status, r[12].stderr).toBe(0);
      expect(r[12].state.DUMP).toBe(r[8].state.SAFETY);
      expect(r[12].state.DUMP).not.toBe(r[10].state.SAFETY);
      expect(r[13].status, r[13].stderr).toBe(0);
      expect(r[13].db).toEqual(["up_users 3", "posts 5"]);
      expect(r[14].status, r[14].stderr).toBe(0);
      expect(r[15].status, r[15].stderr).toBe(0);
      expect(r[15].apps).toBe("running");
    });
  },
);

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
        `attempt ${r[0].state.ATTEMPT} did not finish; back from here goes to ${r[0].state.SAFETY}`,
      );
      expect(r[2].state.ORIGIN).toBe(r[0].state.SAFETY);
      expect(r[3].status).toBe(1);
      expect(r[4].state.DUMP).toBe(r[0].state.SAFETY);
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

describe.skipIf(!FAST)(
  `restore-db.sh: order, the env-only pair, the lock and the edge${FAST_TITLE}`,
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = restoreSteps(
        [
          /* 0 */ { args: ["start"] },
          /* 1 */ { args: ["rotate-jwt"] },
          /* 2 */ { args: ["start", "--env-only"] },
          /* 3 */ { args: ["rotate-jwt", "--env-only"] },
          /* 4 */ { args: ["start", "--env-only"] },
          /* 5 */ { args: ["start", "--env-only"] },
          /* 6 */ { args: ["prepare", "good.dump"] },
          /* 7 */ { args: ["start"] },
          /* 8 */ { args: ["apply"] },
          /* 9 */ { args: ["rotate-jwt", "--env-only"] },
          /* 10 */ { args: ["start", "--env-only"] },
          /* 11 */ { args: ["start"] },
          /* 12 */ { before: "STUB_LOCK_HELD=1", args: ["rotate-jwt"] },
          /* 13 */ {
            before: "STUB_LOCK_HELD=",
            args: ["rotate-jwt"],
            env: { RESTORE_EDGE: "caddy" },
          },
          /* 14 */ { before: "STUB_EDGE=", args: ["rotate-jwt", "--env-only"] },
          /* 15 */ { before: "STUB_EDGE=mixed", args: ["rotate-jwt", "--env-only"] },
          /* 16 */ {
            before: "STUB_EDGE=",
            args: ["rotate-jwt", "--env-only"],
            env: { RESTORE_EDGE: "caddy" },
          },
          /* 17 */ { args: ["prepare"] },
          /* 18 */ { args: ["rotate-jwt", "--now"] },
          /* 19 */ { args: ["status"], env: { COMPOSE_PROJECT: "staging" } },
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
      expect(r[7].status).toBe(1);
      expect(r[11].status).toBe(1);
      for (const n of [0, 1, 2, 7, 11]) expect(r[n].status, `step ${n}`).toBe(1);
      expect(r[0].jwt).toEqual(["old-secret"]);
    });

    it("the env-only pair rotates and starts once", () => {
      expect(r[3].status, r[3].stderr).toBe(0);
      expect(okLine(r[3])).toContain("JWT_SECRET rotated (infra/.env only)");
      expect(r[4].status, r[4].stderr).toBe(0);
      expect(r[4].apps).toBe("running");
      expect(r[4].envOnly.STARTED_AT).not.toBe("");
      expect(r[5].status).toBe(1);
    });

    it("start --env-only is refused while a database restore is unfinished", () => {
      expect(r[8].status, r[8].stderr).toBe(0);
      expect(r[9].status, r[9].stderr).toBe(0);
      expect(r[10].status).toBe(1);
      expect(stopLine(r[10])).toContain(
        `attempt ${r[6].state.ATTEMPT} of a database restore is not finished`,
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

    it("the attempt keeps its compose files: another edge now is refused", () => {
      expect(r[13].status).toBe(1);
      expect(stopLine(r[13])).toContain(
        "the attempt runs with the traefik compose files, but caddy is selected now",
      );
    });

    it("without containers or with mixed ones the edge must be named; caddy uses the base file alone", () => {
      expect(stopLine(r[14])).toContain(
        "compose project infra has no containers: set RESTORE_EDGE=traefik or RESTORE_EDGE=caddy",
      );
      expect(stopLine(r[15])).toContain("were started with and without docker-compose.traefik.yml");
      expect(r[16].status, r[16].stderr).toBe(0);
      const config = r[16].calls.find((c) => c.includes(" config --format json cms"));
      expect(config).toMatch(
        /^docker compose -p infra -f \/\S*\/infra\/docker-compose\.yml config --format json cms$/,
      );
    });

    it("usage errors exit 2; another compose project has its own (empty) state", () => {
      expect(r[17].status).toBe(2);
      expect(r[18].status).toBe(2);
      expect(r[19].status).toBe(0);
      expect(r[19].stdout).toMatch(/^no restore attempt of compose project staging \(/);
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

  it("restores an older dump over a newer database, rotates and starts with the new secret", () => {
    expect(one("start.tables")).toBe("3");
    for (const step of ["b.prepare", "b.apply", "b.rotate", "b.start"]) {
      expect(one(`${step}.rc`), `${step}: ${one(`${step}.err`)}`).toBe("0");
    }
    expect(one("b.tables")).toBe("2");
    expect(one("b.users")).toBe("3");
    expect(one("b.running")).toBe("cms db web ");
    expect(one("b.envsum")).not.toBe(one("start.envsum"));
    // The running cms container holds the rotated secret.
    expect(one("b.cmssum")).toBe(one("b.envsum"));
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
