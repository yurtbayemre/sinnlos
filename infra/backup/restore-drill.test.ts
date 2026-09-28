/**
 * infra/backup/restore-drill.sh (FX36): the off-box restore drill. The real
 * decrypt-and-restore runs against Docker and a GPG key (lane rehearsal,
 * docs/DEPLOYMENT.md §7.3); pinned here:
 *   1. it picks the newest database artifact by the timestamp in its name,
 *      nightly and -predeploy alike, and nothing else;
 *   2. the throwaway Postgres has no network and keeps its data on a tmpfs,
 *      and is removed with its volumes on exit;
 *   3. the decrypted dump is streamed into pg_restore, never written to disk.
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
