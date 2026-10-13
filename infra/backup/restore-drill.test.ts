/**
 * infra/backup/restore-drill.sh (FX36): the off-box restore drill. The real
 * decrypt-and-restore runs against Docker and a GPG key (lane rehearsal,
 * docs/DEPLOYMENT.md §7.3); pinned here:
 *   1. it picks the newest database artifact by the timestamp in its name,
 *      nightly and -predeploy alike, and nothing else;
 *   2. the throwaway Postgres has no network and keeps its data on a tmpfs,
 *      and is removed with its volumes on exit;
 *   3. the decrypted dump is streamed into pg_restore, never written to disk;
 *   4. --all checks the uploads and .env artifacts of the dump's own run
 *      (its timestamp and kind), never the newest of each series, and fails
 *      when one of them is missing (B10-T3; run with docker and gpg stubbed);
 *   5. --generation (backup-run, age): COMPLETE must name the directory and
 *      MANIFEST every other file with its sha256; each component decrypts
 *      with the identity and matches plain.<component>.sha256; the dump
 *      restores in one transaction; uploads and config are listed by name
 *      (an .env by its key count); the plaintext goes with the run (age,
 *      zstd and docker stubbed). With SINNLOS_SLOW_SHELL_TESTS=1 the same
 *      against real age, zstd and Postgres 16 (natively, or in
 *      SINNLOS_SHELL_RUNNER_IMAGE: infra/shell-runner.test.helper.ts).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  dockerReachable,
  runBash,
  shellMode,
  skipReason,
  type ShellMode,
} from "../shell-runner.test.helper";

const SCRIPT = readFileSync(new URL("./restore-drill.sh", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;

function shellFunction(name: string): string {
  const start = SCRIPT.search(new RegExp(`\\n${name}\\(\\) \\{`));
  if (start < 0) throw new Error(`${name}() not found in restore-drill.sh`);
  const end = SCRIPT.indexOf("\n}\n", start + 1);
  return SCRIPT.slice(start + 1, end + 2);
}

/** newest_artifact on files created (empty, in this order) in a temp dir. */
function newest(files: readonly string[], stem: string, ext: string): string {
  const script = [
    "set -euo pipefail",
    'd="$(mktemp -d)"',
    "trap 'rm -rf \"$d\"' EXIT",
    shellFunction("newest_artifact"),
    ...files.map((f) => `: > "$d/${f}"`),
    `p="$(newest_artifact "$d" ${stem} ${ext})"`,
    'echo "${p##*/}"',
    "",
  ].join("\n");
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.trim();
}

describe.skipIf(!HAS_BASH)("restore-drill.sh: which artifact", { timeout: 30_000 }, () => {
  it("takes the newest database dump by its timestamp, nightly or pre-deploy", () => {
    const files = [
      "sinnlos-db-20260928-030000.dump.gz.gpg",
      "sinnlos-db-20260928-141500-predeploy.dump.gz.gpg",
      "sinnlos-db-20260927-030000.dump.gz.gpg",
    ];
    expect(newest(files, "sinnlos-db", "dump")).toBe(
      "sinnlos-db-20260928-141500-predeploy.dump.gz.gpg",
    );
    expect(newest([...files, "sinnlos-db-20260929-030000.dump.gz.gpg"], "sinnlos-db", "dump")).toBe(
      "sinnlos-db-20260929-030000.dump.gz.gpg",
    );
  });

  it("ignores other stems, foreign names and plaintext, and finds nothing in their absence", () => {
    const foreign = [
      "sinnlos-db-pre-datetime.dump.gz.gpg",
      "sinnlos-db-20260930-030000.dump",
      "sinnlos-db-20260930-030000.dump.gz",
      "sinnlos-db-20260930-030000-manual.dump.gz.gpg",
      "sinnlos-uploads-20260930-030000.tar.gz.gpg",
      ".sinnlos-db-20260930-030000.dump.gz.gpg.partial",
    ];
    expect(newest(foreign, "sinnlos-db", "dump")).toBe("");
    expect(
      newest([...foreign, "sinnlos-db-20260901-030000.dump.gz.gpg"], "sinnlos-db", "dump"),
    ).toBe("sinnlos-db-20260901-030000.dump.gz.gpg");
    expect(newest(foreign, "sinnlos-uploads", "tar")).toBe(
      "sinnlos-uploads-20260930-030000.tar.gz.gpg",
    );
  });
});

describe("restore-drill.sh: a throwaway database that leaves nothing behind", () => {
  const lines = SCRIPT.split("\n").map((l) => l.trim());

  it("runs Postgres 16 without network, with its data on a tmpfs", () => {
    expect(SCRIPT).toContain('IMAGE="postgres:16-alpine"');
    const run = SCRIPT.slice(SCRIPT.indexOf('docker run -d --name "$NAME"'));
    expect(run.slice(0, run.indexOf('"$IMAGE"'))).toMatch(
      /--network none --tmpfs \/var\/lib\/postgresql\/data/,
    );
  });

  it("removes the container with its volumes on every exit unless --keep succeeded", () => {
    const cleanup = shellFunction("cleanup");
    expect(cleanup).toContain('docker rm -f -v "$NAME"');
    expect(cleanup).toContain("! ((KEEP && rc == 0))");
    expect(lines).toContain("trap cleanup EXIT");
    for (const trap of ["trap 'exit 129' HUP", "trap 'exit 130' INT", "trap 'exit 143' TERM"]) {
      expect(lines, trap).toContain(trap);
    }
  });

  it("streams the decrypted dump into pg_restore instead of writing it to disk", () => {
    expect(SCRIPT).toMatch(
      /"\$\{GPG\[@\]\}" --decrypt "\$DUMP" \| gunzip \|\n\s+docker exec -i "\$NAME" pg_restore [^\n]*--exit-on-error/,
    );
    // No --output for any decrypt.
    expect(SCRIPT).not.toMatch(/--decrypt[^\n]*--output/);
    expect(lines).toContain("umask 077");
  });
});

/** What a stubbed `restore-drill.sh --all` run printed. */
interface DrillReport {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `restore-drill.sh --all <dir or file>` on artifacts made in a temp
 * dir ($d/art), with docker and gpg stubbed: gpg --decrypt prints the file
 * (the artifacts here are plain gzip: a dump, a tar of two files, an .env of
 * two keys), docker plays the throwaway Postgres (ready at once, the restore
 * reads its input, the row count lists up_users). `target` is relative to
 * $d/art ("" = the directory).
 */
function drillAll(files: Record<string, "dump" | "tar" | "env">, target = ""): DrillReport {
  const script = [
    "set -uo pipefail",
    'd="$(mktemp -d)"',
    "trap 'rm -rf \"$d\"' EXIT",
    'mkdir "$d/art" "$d/u"; echo a > "$d/u/a.png"; echo b > "$d/u/b.png"',
    "mkart() {",
    '  case "$2" in',
    '    dump) echo PGDMP | gzip > "$d/art/$1" ;;',
    '    tar) tar -cf - -C "$d/u" . | gzip > "$d/art/$1" ;;',
    "    env) printf 'APP_KEYS=x\nJWT_SECRET=y\n' | gzip > \"$d/art/$1\" ;;",
    "  esac",
    "}",
    ...Object.entries(files).map(([name, kind]) => `mkart ${name} ${kind}`),
    "docker() {",
    '  case "$1" in',
    "    run) echo stub-container ;;",
    "    exec)",
    '      if [[ "$*" == *pg_isready* ]]; then return 0; fi',
    '      if [[ "$*" == *pg_restore* ]]; then cat > /dev/null; return 0; fi',
    '      if [[ "$*" == *psql* ]]; then cat > /dev/null; printf "polls 2\nup_users 3\n"; return 0; fi',
    "      return 9 ;;",
    "    rm) return 0 ;;",
    "    *) return 9 ;;",
    "  esac",
    "}",
    'gpg() { local last; for last; do :; done; if [[ "$*" == *--decrypt* ]]; then cat "$last"; fi; }',
    "gpgconf() { :; }",
    "export -f docker gpg gpgconf",
    "cat > \"$d/restore-drill.sh\" <<'RESTORE_DRILL_EOF'",
    SCRIPT.trimEnd(),
    "RESTORE_DRILL_EOF",
    `bash "$d/restore-drill.sh" --all --name b10i-drill-stub "$d/art/${target}" > "$d/out" 2> "$d/err"; rc=$?`,
    'echo "STATUS $rc"',
    'sed "s/^/OUT /" "$d/out"',
    'sed "s/^/ERR /" "$d/err"',
    "",
  ].join("\n");
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  expect(res.stderr, "harness stderr").toBe("");
  const lines = res.stdout.split("\n");
  const pick = (prefix: string) =>
    lines
      .filter((l) => l.startsWith(`${prefix} `))
      .map((l) => l.slice(prefix.length + 1))
      .join("\n");
  return { status: Number(pick("STATUS")), stdout: pick("OUT"), stderr: pick("ERR") };
}

describe.skipIf(!HAS_BASH)(
  "restore-drill.sh --all: the artifacts of the dump's own run (B10-T3)",
  { timeout: 30_000 },
  () => {
    it("checks the uploads and .env of the dump's run, not the newest of each series", () => {
      const run = drillAll({
        "sinnlos-db-20260928-030000.dump.gz.gpg": "dump",
        "sinnlos-uploads-20260928-030000.tar.gz.gpg": "tar",
        "sinnlos-env-20260928-030000.env.gz.gpg": "env",
        // Newer uploads and .env artifacts of other runs.
        "sinnlos-uploads-20260928-141500-predeploy.tar.gz.gpg": "tar",
        "sinnlos-env-20260929-030000.env.gz.gpg": "env",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(
        "restore-drill: uploads: sinnlos-uploads-20260928-030000.tar.gz.gpg holds 2 file(s)",
      );
      expect(run.stdout).toContain(
        "restore-drill: env: sinnlos-env-20260928-030000.env.gz.gpg holds 2 key(s) (values not shown)",
      );
      expect(run.stdout).toContain(
        "restore-drill: OK — sinnlos-db-20260928-030000.dump.gz.gpg restored: 2 tables, 5 rows, 3 user(s)",
      );
    });

    it("fails when the dump's run has no uploads or .env artifact, even with older ones there", () => {
      const run = drillAll({
        "sinnlos-db-20260928-030000.dump.gz.gpg": "dump",
        "sinnlos-uploads-20260928-030000.tar.gz.gpg": "tar",
        "sinnlos-env-20260928-030000.env.gz.gpg": "env",
        // The newest run skipped its .env (a partial run).
        "sinnlos-db-20260929-030000.dump.gz.gpg": "dump",
        "sinnlos-uploads-20260929-030000.tar.gz.gpg": "tar",
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain(
        "restore-drill: uploads: sinnlos-uploads-20260929-030000.tar.gz.gpg holds 2 file(s)",
      );
      expect(run.stderr).toContain(
        "restore-drill: FAIL — --all: the run of sinnlos-db-20260929-030000.dump.gz.gpg has no sinnlos-env-20260929-030000.env.gz.gpg in ",
      );
      expect(run.stdout).not.toContain("OK —");
    });

    it("pairs a given pre-deploy dump with that run's -predeploy artifacts", () => {
      const files = {
        "sinnlos-db-20260928-141500-predeploy.dump.gz.gpg": "dump",
        "sinnlos-uploads-20260928-141500-predeploy.tar.gz.gpg": "tar",
        "sinnlos-env-20260928-141500-predeploy.env.gz.gpg": "env",
        "sinnlos-db-20260929-030000.dump.gz.gpg": "dump",
      } as const;
      const run = drillAll(files, "sinnlos-db-20260928-141500-predeploy.dump.gz.gpg");
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("uploads: sinnlos-uploads-20260928-141500-predeploy.tar.gz.gpg");
      expect(run.stdout).toContain("env: sinnlos-env-20260928-141500-predeploy.env.gz.gpg");
      // The newest dump of the directory (a nightly one) has neither: both missing.
      const newest = drillAll(files);
      expect(newest.status).toBe(1);
      expect(newest.stderr).toContain(
        "has no sinnlos-uploads-20260929-030000.tar.gz.gpg sinnlos-env-20260929-030000.env.gz.gpg in ",
      );
    });
  },
);

/* ------------------------------------------------------------------------ */
/* B. backup-run generations (age)                                          */
/* ------------------------------------------------------------------------ */

const GENERATION_FIXTURE = readFileSync(
  new URL("./restore-drill.test-generation.sh", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

interface GenerationReport extends DrillReport {
  /** Entries left in the drill's TMPDIR after the run (the decrypted plaintext). */
  left: number;
  /** The pg_restore command line and what it read (stubbed docker). */
  restoreCall: string;
  restored: string;
}

/**
 * Runs `restore-drill.sh --generation <G> --identity <identity>` on a
 * generation built in a temp dir ($G, 20261012T180345Z-predeploy), with age,
 * zstd and docker stubbed: an "encrypted" component is the line
 * AGE-TO:key-one and then its plaintext (zstd is cat), and age -d -i <file>
 * decrypts only with an identity file holding key-one ($d/key.txt; $d/
 * wrong.txt holds key-two). `mutate` runs after the generation is built.
 */
function drillGeneration(mutate: string, identity = "key.txt"): GenerationReport {
  const script = [
    "set -uo pipefail",
    'd="$(mktemp -d)"',
    "trap 'rm -rf \"$d\"' EXIT",
    GENERATION_FIXTURE,
    'mkdir -p "$d/plain" "$d/tmp"',
    'make_plain "$d/plain"',
    "printf 'PGDMP a fake custom-format dump\\n' > \"$d/plain/db.dump\"",
    'echo key-one > "$d/key.txt"; echo key-two > "$d/wrong.txt"; export d',
    'encrypt() { echo "AGE-TO:key-one"; cat; }',
    'G="$d/gen/20261012T180345Z-predeploy"',
    'make_generation "$G" "$d/plain"',
    mutate,
    "age() {",
    '  local id="" f=""',
    "  while (($#)); do",
    '    case "$1" in -d) shift ;; -i) id="$2"; shift 2 ;; *) f="$1"; shift ;; esac',
    "  done",
    '  if [[ "$(head -n 1 "$f")" != "AGE-TO:$(cat "$id")" ]]; then',
    '    echo "age: error: no identity matched any of the recipients" >&2; return 1',
    "  fi",
    '  tail -n +2 "$f"',
    "}",
    "zstd() { cat; }",
    "docker() {",
    '  case "$1" in',
    "    run) echo stub-container ;;",
    "    exec)",
    '      if [[ "$*" == *pg_isready* ]]; then return 0; fi',
    '      if [[ "$*" == *pg_restore* ]]; then echo "$*" > "$d/restore-call"; cat > "$d/restored"; return 0; fi',
    '      if [[ "$*" == *psql* ]]; then cat > /dev/null; printf "posts 3\\nup_users 4\\n"; return 0; fi',
    "      return 9 ;;",
    "    rm) return 0 ;;",
    "    *) return 9 ;;",
    "  esac",
    "}",
    "gpgconf() { :; }",
    "export -f docker age zstd gpgconf",
    "cat > \"$d/restore-drill.sh\" <<'RESTORE_DRILL_EOF'",
    SCRIPT.trimEnd(),
    "RESTORE_DRILL_EOF",
    `TMPDIR="$d/tmp" bash "$d/restore-drill.sh" --generation "$G" --identity "$d/${identity}" --name drill-stub > "$d/out" 2> "$d/err"; rc=$?`,
    'echo "STATUS $rc"',
    'sed "s/^/OUT /" "$d/out"',
    'sed "s/^/ERR /" "$d/err"',
    'echo "LEFT $(find "$d/tmp" -mindepth 1 | wc -l)"',
    'if [[ -f "$d/restore-call" ]]; then sed "s/^/CALL /" "$d/restore-call"; sed "s/^/RESTORED /" "$d/restored"; fi',
    "",
  ].join("\n");
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  expect(res.stderr, "harness stderr").toBe("");
  const lines = res.stdout.split("\n");
  const pick = (prefix: string) =>
    lines
      .filter((l) => l.startsWith(`${prefix} `))
      .map((l) => l.slice(prefix.length + 1))
      .join("\n");
  return {
    status: Number(pick("STATUS")),
    stdout: pick("OUT"),
    stderr: pick("ERR"),
    left: Number(pick("LEFT")),
    restoreCall: pick("CALL"),
    restored: pick("RESTORED"),
  };
}

describe.skipIf(!HAS_BASH)(
  "restore-drill.sh --generation: a backup-run generation (age)",
  { timeout: 60_000 },
  () => {
    it("checks the generation, decrypts and compares every component, restores and lists", () => {
      const run = drillGeneration("");
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(
        "restore-drill: generation 20261012T180345Z-predeploy: COMPLETE, and 4 file(s) match MANIFEST",
      );
      for (const comp of ["config.tar", "db.dump", "db-globals.sql", "uploads.tar"]) {
        expect(run.stdout).toContain(`restore-drill: ${comp}: decrypted, `);
      }
      expect(run.stdout).toMatch(/restore-drill: db\.dump: decrypted, \d+ bytes, matches MANIFEST/);
      expect(run.restoreCall).toContain("--exit-on-error --single-transaction");
      expect(run.restoreCall).toContain("--no-owner --no-privileges");
      expect(run.restored).toBe("PGDMP a fake custom-format dump");
      expect(run.stdout).toContain("restore-drill: db-globals.sql: 1 role(s) (not applied");
      expect(run.stdout).toContain("restore-drill: uploads.tar: 2 file(s)");
      expect(run.stdout).toContain("  ./avatars/a.png");
      expect(run.stdout).toContain(
        "restore-drill:   home/bigemo/git/sinnlos/infra/.env (2 key(s), values not shown)",
      );
      expect(run.stdout).toContain(
        "restore-drill: OK — generation 20261012T180345Z-predeploy restored: 2 tables, 7 rows, 4 user(s)",
      );
      // No value of the .env, and no plaintext left behind.
      expect(run.stdout + run.stderr).not.toMatch(/drill-secret-value|drill-db-password/);
      expect(run.left).toBe(0);
    });

    it("fails on a changed file (its sha256 in MANIFEST) before decrypting anything", () => {
      const run = drillGeneration('printf x >> "$G/uploads.tar.zst.age"');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "restore-drill: FAIL — uploads.tar.zst.age does not match its sha256 in MANIFEST: changed or damaged since the backup",
      );
      expect(run.stdout).not.toContain("decrypted");
      expect(run.restoreCall).toBe("");
    });

    it("fails without COMPLETE, or with a COMPLETE that names another generation", () => {
      const none = drillGeneration('rm "$G/COMPLETE"');
      expect(none.status).toBe(1);
      expect(none.stderr).toContain(
        "restore-drill: FAIL — 20261012T180345Z-predeploy has no COMPLETE: the backup run did not finish this generation; do not use it",
      );
      const other = drillGeneration(
        'echo "20261011T040000Z-daily 2026-10-11T04:00:09Z" > "$G/COMPLETE"',
      );
      expect(other.status).toBe(1);
      expect(other.stderr).toContain("names '20261011T040000Z-daily', not this directory");
    });

    it("fails with an identity that is not one of the recipients", () => {
      const run = drillGeneration("", "wrong.txt");
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("age: error: no identity matched any of the recipients");
      expect(run.stderr).toMatch(
        /restore-drill: FAIL — could not decrypt \S+\.zst\.age with \S*wrong\.txt/,
      );
      expect(run.restoreCall).toBe("");
      expect(run.left).toBe(0);
    });

    it("fails on a file MANIFEST does not list, and on a listed file that is missing", () => {
      const extra = drillGeneration('echo note > "$G/notes.txt"');
      expect(extra.status).toBe(1);
      expect(extra.stderr).toContain(
        "notes.txt is in 20261012T180345Z-predeploy but not in its MANIFEST",
      );
      const missing = drillGeneration('rm "$G/db-globals.sql.zst.age"');
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("db-globals.sql.zst.age is in MANIFEST but missing");
    });

    it("fails when a component decrypts to other bytes than plain.<component>.sha256", () => {
      // A replaced file whose MANIFEST line was rewritten to match: only the
      // plaintext checksum catches it.
      const run = drillGeneration(
        'printf "PGDMP another dump\\n" | encrypt > "$G/db.dump.zst.age"; reseal "$G" db.dump.zst.age',
      );
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("COMPLETE, and 4 file(s) match MANIFEST");
      expect(run.stderr).toContain(
        "restore-drill: FAIL — the plaintext of db.dump.zst.age does not match plain.db.dump.sha256 of MANIFEST: not what was backed up",
      );
      expect(run.restoreCall).toBe("");
      expect(run.left).toBe(0);
    });

    it("fails on a generation without one of the four sinnlos components", () => {
      const run = drillGeneration(
        'rm "$G/config.tar.zst.age"; sed -i "/config\\.tar/d" "$G/MANIFEST"',
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "restore-drill: FAIL — 20261012T180345Z-predeploy has no config.tar.zst.age: an incomplete sinnlos generation",
      );
    });
  },
);

describe("restore-drill.sh --generation: arguments", () => {
  const usage = (args: string[]) =>
    spawnSync("bash", ["-s", "--", ...args], { input: SCRIPT, encoding: "utf8" });

  it.skipIf(!HAS_BASH)(
    "needs --identity with --generation, and no GPG option or artifact next to them",
    () => {
      for (const args of [
        ["--generation", "g"],
        ["--identity", "k"],
        ["--generation", "g", "--identity", "k", "--all"],
        ["--generation", "g", "--identity", "k", "--key", "x"],
        ["--generation", "g", "--identity", "k", "some-dir"],
      ]) {
        expect(usage(args).status, args.join(" ")).toBe(2);
      }
    },
  );
});

const SLOW_GENERATION = readFileSync(
  new URL("./restore-drill.test-slow.sh", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const SLOW_TOOLS = ["age", "age-keygen", "zstd", "tar", "sha256sum", "docker"];
const SLOW_MODE: ShellMode | null =
  process.env.SINNLOS_SLOW_SHELL_TESTS === "1" ? shellMode(SLOW_TOOLS, { linux: false }) : null;
const RUN_SLOW = SLOW_MODE !== null && dockerReachable(SLOW_MODE);
const SLOW_TITLE = RUN_SLOW
  ? ""
  : ` (skipped: set SINNLOS_SLOW_SHELL_TESTS=1; ${skipReason(SLOW_TOOLS)})`;

describe.skipIf(!RUN_SLOW)(
  `restore-drill.sh --generation with real age, zstd and Postgres 16${SLOW_TITLE}`,
  () => {
    let o = new Map<string, string[]>();
    const one = (key: string) => (o.get(key) ?? [""]).join("\n");
    beforeAll(() => {
      const script = [
        "set -uo pipefail",
        "umask 077",
        'd="$(mktemp -d)"',
        GENERATION_FIXTURE,
        "cat > \"$d/restore-drill.sh\" <<'RESTORE_DRILL_EOF'",
        SCRIPT.trimEnd(),
        "RESTORE_DRILL_EOF",
        SLOW_GENERATION,
      ].join("\n");
      const res = runBash(script, SLOW_MODE as ShellMode, { timeout: 600_000 });
      for (const line of res.stdout.split("\n")) {
        const m = /^@@(\S+) ?(.*)$/.exec(line);
        if (m) o.set(m[1], [...(o.get(m[1]) ?? []), m[2]]);
      }
      expect(o.get("done"), `${res.stdout}\n${res.stderr}`).toEqual(["1"]);
    }, 600_000);

    it("restores a good generation and leaves no plaintext and no container", () => {
      expect(one("good.rc"), one("good.err")).toBe("0");
      expect(one("good.out")).toContain(
        "restore-drill: OK — generation 20261012T180345Z-predeploy restored: 2 tables, 7 rows, 4 user(s)",
      );
      expect(one("good.out")).toContain(
        "home/bigemo/git/sinnlos/infra/.env (2 key(s), values not shown)",
      );
      expect(one("good.out")).not.toContain("drill-secret-value");
      expect(one("good.left")).toBe("0");
      expect(one("good.containers")).toBe("0");
    });

    it("fails with the wrong identity, on a changed file and without COMPLETE", () => {
      expect(one("wrong.rc")).toBe("1");
      expect(one("wrong.err")).toContain("no identity matched any of the recipients");
      expect(one("tampered.rc")).toBe("1");
      expect(one("tampered.err")).toContain(
        "uploads.tar.zst.age does not match its sha256 in MANIFEST",
      );
      expect(one("incomplete.rc")).toBe("1");
      expect(one("incomplete.err")).toContain("has no COMPLETE");
      for (const c of ["wrong", "tampered", "incomplete"]) {
        expect(one(`${c}.left`), c).toBe("0");
        expect(one(`${c}.containers`), c).toBe("0");
      }
    });
  },
);
