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
 *      when one of them is missing (B10-T3; run with docker and gpg stubbed).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
