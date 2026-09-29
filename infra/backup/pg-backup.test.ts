/**
 * infra/backup/pg-backup.sh (FX36), run in bash with docker and gpg stubbed
 * as exported shell functions (no Docker, no keyring). Pinned:
 *   1. the defaults the host crontab relies on are unchanged (backup root,
 *      container and volume names, the .env paths), and the in-place `cat >`
 *      writes that keep inodes and owners;
 *   2. the retention selection: an artifact goes only when it is older than
 *      7 days (by the timestamp in its name) AND not among the newest 7 of
 *      its series; nightly and -predeploy artifacts are separate series;
 *      other files are never touched;
 *   3. a run: 0600 artifacts, no plaintext left, the last-success file
 *      (nightly runs; pre-deploy runs write last-success-predeploy), ok /
 *      skip / done lines in backup.log, pruning only after the encryption;
 *   4. a failed run and a run killed mid-way leave no plaintext and no
 *      partial artifact, log a FAIL line, prune nothing and keep the old
 *      last-success;
 *   5. plaintext of the script's own names older than an hour in the
 *      backup root (a SIGKILLed run's) is reported as "WARN stale
 *      plaintext" and never removed;
 *   6. a missing offsite dir is created level by level, and a root run
 *      (deploy.sh) gives the levels it creates the backup root's owner,
 *      never root's (B10-T4; root is faked: EUID in the script reads
 *      STUB_EUID, and chown is a stub that records its calls).
 *
 * Every file operation happens inside bash (a temp dir it creates), so no
 * Windows path crosses into the MSYS or WSL side (as in
 * apps/cms/src/utils/deploy-preflight.test.ts). File modes are only
 * asserted where the file system has them (not on Windows).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new URL("./pg-backup.sh", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;
/** Bash starts are slow under a parallel run on Windows (docs/architecture.md §5.40). */
const BASH_BUDGET = { timeout: 60_000 };
const POSIX_MODES = process.platform !== "win32";

/** The body of a top-level shell function in pg-backup.sh, `name() {` to `}`. */
function shellFunction(name: string): string {
  const start = SCRIPT.search(new RegExp(`\\n${name}\\(\\) \\{`));
  if (start < 0) throw new Error(`${name}() not found in pg-backup.sh`);
  const end = SCRIPT.indexOf("\n}\n", start + 1);
  return SCRIPT.slice(start + 1, end + 2);
}

function runBash(script: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("pg-backup.sh: what the host cron relies on", () => {
  it("keeps the default paths and names", () => {
    for (const line of [
      'DB_C="${SINNLOS_DB_CONTAINER:-infra-db-1}"',
      'UPLOADS_VOL="${SINNLOS_UPLOADS_VOLUME:-infra_cms_uploads}"',
      'BK="${SINNLOS_BACKUP_DIR:-/home/bigemo/backups/momsbest}"',
      'OFFSITE="$BK/offsite/sinnlos"',
      'export GNUPGHOME="${SINNLOS_GNUPGHOME:-$BK/.gnupg}"',
      'KEYID_FILE="${SINNLOS_BACKUP_KEYID:-$BK/.backup-keyid}"',
      'LOG="$OFFSITE/backup.log"',
      'ENV_SRC="${SINNLOS_ENV_FILE:-/home/bigemo/git/sinnlos/infra/.env}"',
      'LOCAL_ENV_BK="${SINNLOS_LOCAL_ENV_BACKUP:-/home/bigemo/.sinnlos-env-backup/.env}"',
    ]) {
      expect(SCRIPT.split("\n"), line).toContain(line);
    }
  });

  it("creates nothing readable by others, and cleans up on every exit", () => {
    const lines = SCRIPT.split("\n");
    const first = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    expect(first("set -Eeuo pipefail")).toBeGreaterThan(-1);
    expect(first("umask 077")).toBe(first("set -Eeuo pipefail") + 1);
    // umask before the first file or directory the run writes.
    expect(first("umask 077")).toBeLessThan(first('    mkdir "$d"'));
    for (const trap of [
      "trap on_exit EXIT",
      "trap 'exit 129' HUP",
      "trap 'exit 130' INT",
      "trap 'exit 143' TERM",
    ]) {
      expect(lines, trap).toContain(trap);
    }
    const onExit = shellFunction("on_exit");
    for (const name of ["OUT", "UOUT", "EOUT"]) {
      expect(onExit, name).toContain(`\${${name}:+"$${name}" "$${name}.gz"}`);
    }
    expect(onExit).toContain('${PARTIAL:+"$PARTIAL"}');
  });

  it("refreshes the quick-access .env copy and the log in place (cat >), never creating the copy", () => {
    expect(SCRIPT).toContain(
      '  if [[ -f "$LOCAL_ENV_BK" ]]; then\n    cat "$ENV_SRC" > "$LOCAL_ENV_BK"',
    );
    expect(SCRIPT).toContain('cat "$TRIM_TMP" > "$LOG"');
    expect(SCRIPT).not.toMatch(/\bmv\b[^\n]*"\$LOG"/);
  });

  it("prunes only after the new artifact is encrypted and in place", () => {
    const finalize = shellFunction("finalize");
    const encrypt = finalize.indexOf("--encrypt");
    const inPlace = finalize.indexOf('mv -f "$PARTIAL" "$target"');
    const prune = finalize.indexOf("retention_victims");
    expect(encrypt).toBeGreaterThan(-1);
    expect(inPlace).toBeGreaterThan(encrypt);
    expect(prune).toBeGreaterThan(inPlace);
  });
});

/**
 * retention_victims on fabricated file names: `files` are created (empty)
 * in a temp dir, in the given order, and the paths it selects come back as
 * bare names, in its order (newest first).
 */
function victims(
  files: readonly string[],
  args: { stem: string; ext: string; tag: string; cutoff: string },
): string[] {
  const script = [
    "set -euo pipefail",
    'd="$(mktemp -d)"',
    "trap 'rm -rf \"$d\"' EXIT",
    "RETENTION_KEEP=7",
    shellFunction("retention_victims"),
    ...files.map((f) => `: > "$d/${f}"`),
    `retention_victims "$d" ${args.stem} ${args.ext} '${args.tag}' ${args.cutoff}`,
    'for v in ${RETENTION_VICTIMS[@]+"${RETENTION_VICTIMS[@]}"}; do echo "${v##*/}"; done',
    "",
  ].join("\n");
  const res = runBash(script);
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.split("\n").filter(Boolean);
}

/** `stem-YYYYmmdd-HHMMSS<tag>.<ext>.gz.gpg` for day `day` of September 2026. */
const artifact = (stem: string, day: number, tag = "", ext = "dump") =>
  `${stem}-202609${String(day).padStart(2, "0")}-030000${tag}.${ext}.gz.gpg`;
const DB = { stem: "sinnlos-db", ext: "dump", tag: "", cutoff: "20260920-030000" };

describe.skipIf(!HAS_BASH)("pg-backup.sh retention selection", BASH_BUDGET, () => {
  it("keeps everything younger than 7 days, however many there are", () => {
    const young = Array.from(
      { length: 12 },
      (_, i) => `sinnlos-db-20260925-0300${String(i).padStart(2, "0")}.dump.gz.gpg`,
    );
    expect(victims(young, DB)).toEqual([]);
  });

  it("keeps the newest 7 even when all are older than 7 days", () => {
    const old = Array.from({ length: 10 }, (_, i) => artifact("sinnlos-db", i + 1));
    expect(victims(old, DB)).toEqual([
      artifact("sinnlos-db", 3),
      artifact("sinnlos-db", 2),
      artifact("sinnlos-db", 1),
    ]);
    expect(victims(old.slice(0, 7), DB)).toEqual([]);
  });

  it("removes an old artifact only when it is also outside the newest 7", () => {
    // 3 young ones (21st-23rd), 6 old ones (10th-15th): the newest 7 are the
    // 3 young and the 4 newest old ones; the 10th and 11th go.
    const files = [21, 22, 23, 10, 11, 12, 13, 14, 15].map((day) => artifact("sinnlos-db", day));
    expect(victims(files, DB)).toEqual([artifact("sinnlos-db", 11), artifact("sinnlos-db", 10)]);
    // The cutoff itself counts as young.
    expect(victims(files, { ...DB, cutoff: "20260911-030000" })).toEqual([
      artifact("sinnlos-db", 10),
    ]);
  });

  it("treats nightly and -predeploy artifacts as separate series", () => {
    const nightly = Array.from({ length: 9 }, (_, i) => artifact("sinnlos-db", i + 1));
    const predeploy = Array.from({ length: 9 }, (_, i) =>
      artifact("sinnlos-db", i + 1, "-predeploy"),
    );
    const files = [...nightly, ...predeploy];
    expect(victims(files, DB)).toEqual([artifact("sinnlos-db", 2), artifact("sinnlos-db", 1)]);
    expect(victims(files, { ...DB, tag: "-predeploy" })).toEqual([
      artifact("sinnlos-db", 2, "-predeploy"),
      artifact("sinnlos-db", 1, "-predeploy"),
    ]);
    // Predeploy runs never count toward the nightly 7.
    expect(victims([...nightly.slice(0, 7), ...predeploy], DB)).toEqual([]);
  });

  it("never lists another stem, a foreign name or a plaintext file", () => {
    const old = Array.from({ length: 9 }, (_, i) => artifact("sinnlos-db", i + 1));
    const foreign = [
      artifact("sinnlos-uploads", 1, "", "tar"),
      artifact("sinnlos-env", 1, "", "env"),
      "sinnlos-db-pre-datetime.dump.gz.gpg",
      "sinnlos-db-20260901-030000.dump",
      "sinnlos-db-20260901-030000.dump.gz",
      "sinnlos-db-20260901-030000-manual.dump.gz.gpg",
      ".sinnlos-db-20260901-030000.dump.gz.gpg.partial",
      "backup.log",
      "last-success",
    ];
    expect(victims([...old, ...foreign], DB)).toEqual([
      artifact("sinnlos-db", 2),
      artifact("sinnlos-db", 1),
    ]);
    expect(victims(foreign, DB)).toEqual([]);
  });

  it("selects within the uploads and env stems the same way", () => {
    const uploads = Array.from({ length: 8 }, (_, i) =>
      artifact("sinnlos-uploads", i + 1, "", "tar"),
    );
    expect(victims(uploads, { ...DB, stem: "sinnlos-uploads", ext: "tar" })).toEqual([
      artifact("sinnlos-uploads", 1, "", "tar"),
    ]);
    const env = Array.from({ length: 8 }, (_, i) =>
      artifact("sinnlos-env", i + 1, "-predeploy", "env"),
    );
    expect(victims(env, { ...DB, stem: "sinnlos-env", ext: "env", tag: "-predeploy" })).toEqual([
      artifact("sinnlos-env", 1, "-predeploy", "env"),
    ]);
  });
});

/** Options of one stubbed run. */
interface RunOptions {
  /** Environment for pg-backup.sh (on top of the backup dir and key paths). */
  env?: Record<string, string>;
  /** Bash run before pg-backup.sh, with $BK, $OFFSITE and `mk` (see below). */
  setup?: string;
  /** The stubbed uploads volume exists (default true). */
  uploads?: boolean;
  /** Write infra/.env and the quick-access copy (default true for both). */
  envFile?: boolean;
  quickAccess?: boolean;
  /** gpg fails. */
  gpgFails?: boolean;
  /** Send TERM to the run while gpg works on the first artifact. */
  killDuringGpg?: boolean;
  /** Run as if root ran it (deploy.sh): EUID reads 0, chown is recorded, not run. */
  root?: boolean;
}

interface RunReport {
  status: number;
  /** Names in the backup root (plaintext side), dot files included. */
  root: string[];
  /** Names in the offsite dir. */
  offsite: string[];
  modes: Record<string, string>;
  log: string[];
  lastSuccess: string;
  /** last-success-predeploy (empty without one). */
  lastPredeploy: string;
  quickAccess: string;
  stderr: string;
  /** The stubbed chown calls of a `root` run, with the backup root shown as BK. */
  chowns: string[];
  /** Mode of each offsite dir level that exists ("offsite", "offsite/sinnlos"). */
  dirs: Record<string, string>;
}

/**
 * Runs pg-backup.sh in a fresh temp backup root with docker and gpg
 * stubbed, and reports what is left. `mk <stem> <days ago> <tag> <ext>`
 * creates an old artifact in the offsite dir, timestamped like the script.
 */
function backupRun(options: RunOptions = {}): RunReport {
  const env = {
    SINNLOS_BACKUP_DIR: "$BK",
    SINNLOS_ENV_FILE: "$BK/checkout/infra/.env",
    SINNLOS_LOCAL_ENV_BACKUP: "$BK/quick/.env",
    ...options.env,
  };
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join("\n");
  const script = [
    "set -uo pipefail",
    'T="$(mktemp -d)"',
    "trap 'rm -rf \"$T\"' EXIT",
    'BK="$T/bk"; OFFSITE="$BK/offsite/sinnlos"',
    'mkdir -p "$BK/.gnupg" "$OFFSITE" "$BK/checkout/infra" "$BK/quick"',
    'echo STUBKEY > "$BK/.backup-keyid"',
    options.envFile === false ? "" : 'echo "APP_KEYS=secret1,secret2" > "$BK/checkout/infra/.env"',
    options.quickAccess === false ? "" : 'echo "old copy" > "$BK/quick/.env"',
    `STUB_UPLOADS=${options.uploads === false ? "" : "1"}`,
    `STUB_GPG_FAIL=${options.gpgFails ? "1" : ""}`,
    `STUB_GPG_SLEEP=${options.killDuringGpg ? "2" : ""}`,
    'STUB_MARK="$T/gpg-started"',
    "export STUB_UPLOADS STUB_GPG_FAIL STUB_GPG_SLEEP STUB_MARK",
    "docker() {",
    '  case "$1" in',
    "    exec)",
    '      shift; if [[ "$1" == "-i" ]]; then shift; fi; shift',
    '      case "$1" in',
    '        printenv) echo "stub_$2" ;;',
    "        pg_dump) printf 'PGDMP stub dump\\n' ;;",
    "        pg_restore) cat > /dev/null ;;",
    "        *) return 9 ;;",
    "      esac ;;",
    '    volume) [[ -n "$STUB_UPLOADS" ]] ;;',
    "    run) printf 'stub tar bytes\\n' ;;",
    "    *) return 9 ;;",
    "  esac",
    "}",
    "gpg() {",
    '  local out="" in=""',
    '  while (($#)); do case "$1" in --output) out="$2"; shift 2 ;; *) in="$1"; shift ;; esac; done',
    '  [[ -z "$STUB_GPG_FAIL" ]] || return 2',
    '  if [[ -n "$STUB_GPG_SLEEP" ]]; then : > "$STUB_MARK"; sleep "$STUB_GPG_SLEEP"; fi',
    '  { echo "ENCRYPTED"; cat "$in"; } > "$out"',
    "}",
    'chown() { printf "chown %s\n" "${*//$BK/BK}" >> "$T/chown.log"; }',
    "export -f docker gpg chown",
    "export T BK",
    "printf -v NOW '%(%s)T' -1",
    "mk() {",
    "  local ts; printf -v ts '%(%Y%m%d-%H%M%S)T' \"$((NOW - $2 * 86400))\"",
    '  echo old > "$OFFSITE/$1-$ts$3.$4.gz.gpg"',
    "}",
    options.setup ?? "",
    "cat > \"$T/pg-backup.sh\" <<'PG_BACKUP_SH_EOF'",
    (options.root
      ? SCRIPT.replace(/\(\(EUID == 0\)\)/g, "((${STUB_EUID:-$EUID} == 0))")
      : SCRIPT
    ).trimEnd(),
    "PG_BACKUP_SH_EOF",
    exports,
    options.root ? "export STUB_EUID=0" : "",
    "rc=0",
    options.killDuringGpg
      ? [
          'bash "$T/pg-backup.sh" 2> "$T/stderr" &',
          "pid=$!",
          'for _ in $(seq 1 100); do [[ -e "$STUB_MARK" ]] && break; sleep 0.1; done',
          'kill -TERM "$pid"',
          'wait "$pid" || rc=$?',
        ].join("\n")
      : 'bash "$T/pg-backup.sh" 2> "$T/stderr" || rc=$?',
    'echo "STATUS $rc"',
    'for f in "$BK"/* "$BK"/.[!.]*; do [[ -e "$f" ]] && echo "ROOT ${f##*/}"; done',
    '(cd "$OFFSITE" 2> /dev/null && stat -c "OFFSITE %n %a" -- * .[!.]* 2> /dev/null) || true',
    'if [[ -f "$OFFSITE/backup.log" ]]; then sed "s/^/LOG /" "$OFFSITE/backup.log"; fi',
    'if [[ -f "$OFFSITE/last-success" ]]; then echo "LAST $(cat "$OFFSITE/last-success")"; fi',
    'if [[ -f "$OFFSITE/last-success-predeploy" ]]; then echo "LASTPRE $(cat "$OFFSITE/last-success-predeploy")"; fi',
    'if [[ -f "$BK/quick/.env" ]]; then echo "QUICK $(cat "$BK/quick/.env")"; fi',
    'sed "s/^/STDERR /" "$T/stderr"',
    'if [[ -f "$T/chown.log" ]]; then sed "s/^/CHOWN /" "$T/chown.log"; fi',
    'for d in offsite offsite/sinnlos; do if [[ -d "$BK/$d" ]]; then echo "DIR $d $(stat -c %a "$BK/$d")"; fi; done',
    "",
  ].join("\n");
  const res = runBash(script);
  expect(res.stderr).toBe("");
  const lines = res.stdout.split("\n");
  const pick = (prefix: string) =>
    lines.filter((l) => l.startsWith(`${prefix} `)).map((l) => l.slice(prefix.length + 1));
  const offsiteEntries = pick("OFFSITE").map((l) => l.split(" "));
  return {
    status: Number(pick("STATUS")[0]),
    root: pick("ROOT").sort(),
    offsite: offsiteEntries.map(([name]) => name).sort(),
    modes: Object.fromEntries(offsiteEntries.map(([name, mode]) => [name, mode])),
    log: pick("LOG").map((l) => l.replace(/^\S+ /, "")),
    lastSuccess: pick("LAST")[0] ?? "",
    lastPredeploy: pick("LASTPRE")[0] ?? "",
    quickAccess: pick("QUICK")[0] ?? "",
    stderr: pick("STDERR").join("\n"),
    chowns: pick("CHOWN"),
    dirs: Object.fromEntries(pick("DIR").map((l) => l.split(" "))),
  };
}

const ARTIFACT_RE = (stem: string, tag: string, ext: string) =>
  new RegExp(`^${stem}-\\d{8}-\\d{6}${tag}\\.${ext}\\.gz\\.gpg$`);
/** The plaintext the run must never leave behind in the backup root. */
const PLAINTEXT_RE = /^sinnlos-(db|uploads|env)-.*\.(dump|tar|env)(\.gz)?$/;

describe.skipIf(!HAS_BASH)("pg-backup.sh runs (docker and gpg stubbed)", BASH_BUDGET, () => {
  it("encrypts all three artifacts, leaves no plaintext and records the success", () => {
    const run = backupRun();
    expect(run.status, run.stderr).toBe(0);
    const artifacts = run.offsite.filter((name) => name.endsWith(".gz.gpg"));
    expect(artifacts).toHaveLength(3);
    expect(artifacts.some((n) => ARTIFACT_RE("sinnlos-db", "", "dump").test(n))).toBe(true);
    expect(artifacts.some((n) => ARTIFACT_RE("sinnlos-uploads", "", "tar").test(n))).toBe(true);
    expect(artifacts.some((n) => ARTIFACT_RE("sinnlos-env", "", "env").test(n))).toBe(true);
    expect(run.offsite.filter((n) => n.startsWith("."))).toEqual([]);
    expect(run.root.filter((n) => PLAINTEXT_RE.test(n))).toEqual([]);
    expect(run.log.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([
      "ok sinnlos-db",
      "ok sinnlos-uploads",
      "ok sinnlos-env",
      "done nightly",
    ]);
    const db = artifacts.find((n) => n.startsWith("sinnlos-db-"));
    expect(run.lastSuccess).toMatch(new RegExp(`^\\S+ nightly ${db?.replace(/\./g, "\\.")}$`));
    expect(run.lastPredeploy).toBe("");
    // The quick-access copy is refreshed with the current .env.
    expect(run.quickAccess).toBe("APP_KEYS=secret1,secret2");
    if (POSIX_MODES) {
      for (const name of [...artifacts, "backup.log", "last-success"]) {
        expect(run.modes[name], name).toBe("600");
      }
    }
  });

  it("names pre-deploy artifacts -predeploy, and records them apart from last-success", () => {
    // The last nightly run, which a pre-deploy run must not make look fresher.
    const nightly = "2026-09-28T03:00:07+02:00 nightly sinnlos-db-20260928-030000.dump.gz.gpg";
    const run = backupRun({
      env: { SINNLOS_BACKUP_KIND: "predeploy" },
      setup: `echo '${nightly}' > "$OFFSITE/last-success"`,
    });
    expect(run.status, run.stderr).toBe(0);
    const artifacts = run.offsite.filter((name) => name.endsWith(".gz.gpg"));
    expect(artifacts.every((n) => /-predeploy\.(dump|tar|env)\.gz\.gpg$/.test(n))).toBe(true);
    expect(artifacts).toHaveLength(3);
    expect(run.lastPredeploy).toMatch(
      /^\S+ predeploy sinnlos-db-\d{8}-\d{6}-predeploy\.dump\.gz\.gpg$/,
    );
    expect(run.lastSuccess).toBe(nightly);
    expect(run.log.at(-1)).toBe("done predeploy");
    if (POSIX_MODES) expect(run.modes["last-success-predeploy"]).toBe("600");
  });

  it("refuses an unknown kind before it writes anything", () => {
    const run = backupRun({ env: { SINNLOS_BACKUP_KIND: "weekly" } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("SINNLOS_BACKUP_KIND must be nightly or predeploy");
    expect(run.offsite).toEqual([]);
  });

  it("logs a skip line for a missing uploads volume, .env and quick-access copy", () => {
    const noUploads = backupRun({ uploads: false, quickAccess: false });
    expect(noUploads.status, noUploads.stderr).toBe(0);
    expect(noUploads.log).toContain("skip sinnlos-uploads volume infra_cms_uploads not found");
    expect(noUploads.log.some((l) => l.startsWith("skip sinnlos-env quick-access copy "))).toBe(
      true,
    );
    expect(noUploads.offsite.filter((n) => n.startsWith("sinnlos-uploads-"))).toEqual([]);

    const noEnv = backupRun({ envFile: false });
    expect(noEnv.status, noEnv.stderr).toBe(0);
    expect(
      noEnv.log.some((l) => /^skip sinnlos-env \S+\/checkout\/infra\/\.env not found$/.test(l)),
    ).toBe(true);
    expect(noEnv.log.at(-1)).toBe("done nightly");
  });

  it("gives the offsite dirs a root run creates the backup root's owner, not root's (B10-T4)", () => {
    // deploy.sh's pre-deploy run on a new host: no offsite dir yet.
    const fresh = backupRun({ root: true, setup: 'rm -rf "$BK/offsite"' });
    expect(fresh.status, fresh.stderr).toBe(0);
    const reBk = (c: string) => c.startsWith("chown --reference=BK ");
    expect(fresh.chowns.filter(reBk)).toEqual([
      "chown --reference=BK BK/offsite",
      "chown --reference=BK BK/offsite/sinnlos",
    ]);
    // What it writes into the offsite dir takes that dir's owner, as before.
    const rest = fresh.chowns.filter((c) => !reBk(c));
    expect(rest.length).toBeGreaterThan(0);
    for (const call of rest)
      expect(call).toMatch(/^chown --reference=BK\/offsite\/sinnlos BK\/offsite\/sinnlos\//);
    if (POSIX_MODES) expect(fresh.dirs).toEqual({ offsite: "700", "offsite/sinnlos": "700" });
    expect(Object.keys(fresh.dirs)).toEqual(["offsite", "offsite/sinnlos"]);

    // Dirs that exist keep their owner.
    const existing = backupRun({ root: true });
    expect(existing.status, existing.stderr).toBe(0);
    expect(existing.chowns.filter(reBk)).toEqual([]);

    // The owner's own run creates them without any chown.
    const owner = backupRun({ setup: 'rm -rf "$BK/offsite"' });
    expect(owner.status, owner.stderr).toBe(0);
    expect(owner.chowns).toEqual([]);
    expect(Object.keys(owner.dirs)).toEqual(["offsite", "offsite/sinnlos"]);
  });

  it("refuses a backup root that does not exist, creating nothing", () => {
    const run = backupRun({ root: true, setup: 'rm -rf "$BK"' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("the backup root ");
    expect(run.stderr).toContain(" does not exist (it holds the GPG keyring and .backup-keyid)");
    expect(run.root).toEqual([]);
    expect(run.chowns).toEqual([]);
  });

  it("prunes each series by the time-and-count rule after encrypting", () => {
    const setup = [
      // 10 nightly and 10 pre-deploy db artifacts, 10 to 19 days old; 2 young nightly ones.
      'for d in $(seq 10 19); do mk sinnlos-db "$d" \'\' dump; mk sinnlos-db "$d" -predeploy dump; done',
      "mk sinnlos-db 1 '' dump; mk sinnlos-db 2 '' dump",
      // Foreign files stay.
      'echo keep > "$OFFSITE/sinnlos-db-pre-datetime.dump.gz.gpg"',
      'echo keep > "$OFFSITE/notes.txt"',
    ].join("\n");
    const run = backupRun({ setup });
    expect(run.status, run.stderr).toBe(0);
    const series = (tag: string) =>
      run.offsite.filter((n) => ARTIFACT_RE("sinnlos-db", tag, "dump").test(n));
    // Nightly: the new one, the 2 young ones and the 4 newest old ones.
    expect(series("")).toHaveLength(7);
    // Pre-deploy: the newest 7 of the old ones.
    expect(series("-predeploy")).toHaveLength(7);
    expect(run.offsite).toEqual(
      expect.arrayContaining(["sinnlos-db-pre-datetime.dump.gz.gpg", "notes.txt"]),
    );
    const pruned = run.log.filter((l) => l.startsWith("pruned sinnlos-db "));
    expect(pruned).toHaveLength(6 + 3);
    // Pruning comes after the ok line of the new artifact.
    expect(run.log.findIndex((l) => l.startsWith("pruned "))).toBeGreaterThan(
      run.log.findIndex((l) => l.startsWith("ok sinnlos-db ")),
    );
  });

  it("reports, but keeps, the plaintext a killed run left behind", () => {
    const setup = [
      // A killed run's plaintext, 2 hours old …
      'echo dump > "$BK/sinnlos-db-20260901-030000.dump"',
      'echo tar > "$BK/sinnlos-uploads-20260901-030000-predeploy.tar.gz"',
      'touch -d "2 hours ago" "$BK/sinnlos-db-20260901-030000.dump" "$BK/sinnlos-uploads-20260901-030000-predeploy.tar.gz"',
      // … a run going on right now, and names that are not the script's own.
      'echo now > "$BK/sinnlos-env-20260901-040000.env"',
      'echo keep > "$BK/sinnlos-db-pre-datetime.dump"',
      'echo keep > "$BK/sinnlos-db-20260901-030000.tar"',
      'touch -d "2 hours ago" "$BK/sinnlos-db-pre-datetime.dump" "$BK/sinnlos-db-20260901-030000.tar"',
    ].join("\n");
    const run = backupRun({ setup });
    expect(run.status, run.stderr).toBe(0);
    const warned = run.log.filter((l) => l.startsWith("WARN "));
    expect(warned.sort()).toEqual([
      "WARN stale plaintext sinnlos-db-20260901-030000.dump (left by a killed run; review and delete it)",
      "WARN stale plaintext sinnlos-uploads-20260901-030000-predeploy.tar.gz (left by a killed run; review and delete it)",
    ]);
    expect(run.stderr).toContain("pg-backup: WARNING: stale plaintext ");
    expect(run.stderr).toContain("/sinnlos-db-20260901-030000.dump (left by a killed run");
    // Reported before this run's own work, and never removed.
    expect(run.log.findIndex((l) => l.startsWith("WARN "))).toBeLessThan(
      run.log.findIndex((l) => l.startsWith("ok sinnlos-db ")),
    );
    expect(run.root).toEqual(
      expect.arrayContaining([
        "sinnlos-db-20260901-030000.dump",
        "sinnlos-uploads-20260901-030000-predeploy.tar.gz",
        "sinnlos-env-20260901-040000.env",
        "sinnlos-db-pre-datetime.dump",
      ]),
    );
  });

  it("leaves no plaintext and prunes nothing when gpg fails", () => {
    const setup = [
      "for d in $(seq 10 19); do mk sinnlos-db \"$d\" '' dump; done",
      'echo "2026-09-01T03:00:05+02:00 nightly sinnlos-db-20260901-030000.dump.gz.gpg" > "$OFFSITE/last-success"',
    ].join("\n");
    const run = backupRun({ setup, gpgFails: true });
    expect(run.status).not.toBe(0);
    expect(run.root.filter((n) => PLAINTEXT_RE.test(n))).toEqual([]);
    expect(run.offsite.filter((n) => n.startsWith("."))).toEqual([]);
    expect(run.offsite.filter((n) => n.endsWith(".gz.gpg"))).toHaveLength(10);
    expect(run.log).toEqual([
      expect.stringMatching(/^FAIL nightly sinnlos-db line \d+ \(exit 2\)$/),
    ]);
    expect(run.lastSuccess).toBe(
      "2026-09-01T03:00:05+02:00 nightly sinnlos-db-20260901-030000.dump.gz.gpg",
    );
    expect(run.stderr).toContain("FAILED at sinnlos-db");
  });

  it("leaves no plaintext and no partial artifact when killed mid-run", () => {
    const run = backupRun({ killDuringGpg: true });
    expect(run.status).toBe(143);
    expect(run.root.filter((n) => PLAINTEXT_RE.test(n))).toEqual([]);
    expect(run.offsite.filter((n) => n.startsWith(".") || n.endsWith(".gz.gpg"))).toEqual([]);
    expect(run.log).toEqual(["FAIL nightly sinnlos-db (exit 143)"]);
    expect(run.lastSuccess).toBe("");
  });
});
