/**
 * infra/deploy-env.sh (v0.26): load_deploy_env reads infra/deploy.env as
 * data — KEY=value lines, allowlisted keys, the caller's environment first —
 * and refuses anything it cannot read safely, before deploy.sh or
 * pg-backup.sh change anything. Runs in bash in a temp dir; file modes are
 * only asserted where the file system has them (not on Windows).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LIB = readFileSync(new URL("./deploy-env.sh", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const POSIX_MODES = process.platform !== "win32";
const BASH_BUDGET = { timeout: 60_000 };

/**
 * Writes `content` (exactly, via printf %s) to $T/checkout/infra/deploy.env,
 * runs `setup`, loads it and prints the keys. Returns the exit code, stderr
 * and the printed KEY=value lines (unset keys are not printed).
 */
function load(
  content: string | null,
  setup = "",
): { status: number; stderr: string; vars: string[] } {
  const script = [
    "set -euo pipefail",
    'T="$(mktemp -d)"',
    "trap 'rm -rf \"$T\"' EXIT",
    'mkdir -p "$T/checkout/infra"',
    "cat > \"$T/lib.sh\" <<'LIB_EOF'",
    LIB.trimEnd(),
    "LIB_EOF",
    content === null
      ? ""
      : `printf '%s' '${Buffer.from(content).toString("base64")}' | base64 -d > "$T/checkout/infra/deploy.env"`,
    "unset COMPOSE_PROJECT DEPLOY_EDGE DEPLOY_IMAGE_SOURCE BACKUP_RUN PASSWORDS_FILE SMOKE_URL SINNLOS_BACKUP_DIR SINNLOS_ENV_FILE SINNLOS_LOCAL_ENV_BACKUP",
    setup,
    'source "$T/lib.sh"',
    'load_deploy_env "$T/checkout/infra/deploy.env" "$T/checkout"',
    // Exported, so a child process sees them.
    "bash -c 'for k in COMPOSE_PROJECT DEPLOY_EDGE SMOKE_URL SINNLOS_BACKUP_DIR; do if [[ -v $k ]]; then echo \"VAR $k=${!k}\"; fi; done'",
    "",
  ].join("\n");
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  return {
    status: res.status ?? -1,
    stderr: res.stderr,
    vars: res.stdout
      .split("\n")
      .filter((l) => l.startsWith("VAR "))
      .map((l) => l.slice(4)),
  };
}

describe.skipIf(!HAS_BASH)("load_deploy_env (infra/deploy-env.sh)", BASH_BUDGET, () => {
  it("does nothing without the file", () => {
    const run = load(null);
    expect(run.status, run.stderr).toBe(0);
    expect(run.vars).toEqual([]);
  });

  it("exports the keys literally, skips comments and blank lines, and reads a last line without a newline", () => {
    const run = load(
      "# host settings\n\nCOMPOSE_PROJECT=infra\n  # indented comment\nSMOKE_URL=https://x.test/?a=b&c=$HOME\nDEPLOY_EDGE=traefik",
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.vars).toEqual([
      "COMPOSE_PROJECT=infra",
      "DEPLOY_EDGE=traefik",
      // Split at the first `=`, nothing expanded.
      "SMOKE_URL=https://x.test/?a=b&c=$HOME",
    ]);
  });

  it("keeps the caller's value, an empty one included", () => {
    const run = load(
      "COMPOSE_PROJECT=infra\nDEPLOY_EDGE=traefik\nSINNLOS_BACKUP_DIR=/srv/backup\n",
      "export DEPLOY_EDGE=caddy SINNLOS_BACKUP_DIR=",
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.vars).toEqual(["COMPOSE_PROJECT=infra", "DEPLOY_EDGE=caddy", "SINNLOS_BACKUP_DIR="]);
  });

  it.each([
    ["an unknown key", "COMPOSE_PROJECT=infra\nPATH=/tmp\n", "line 2: unknown key 'PATH'"],
    [
      "a repeated key",
      "COMPOSE_PROJECT=infra\nDEPLOY_EDGE=caddy\nDEPLOY_EDGE=traefik\n",
      "line 3: DEPLOY_EDGE is set twice",
    ],
    ["CRLF", "COMPOSE_PROJECT=infra\r\n", "line 1: CRLF line ending"],
    ["a line without =", "COMPOSE_PROJECT=infra\nexport\n", "line 2: not KEY=value"],
    [
      "a relative path",
      "COMPOSE_PROJECT=infra\nSINNLOS_BACKUP_DIR=backups\n",
      "line 2: SINNLOS_BACKUP_DIR must be an absolute path",
    ],
    ["no COMPOSE_PROJECT", "DEPLOY_EDGE=caddy\n", "COMPOSE_PROJECT=<name> is missing"],
  ])("refuses %s", (_case, content, message) => {
    const run = load(content);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("Nothing was changed");
    expect(run.vars).toEqual([]);
  });

  it("takes the project from the file when the caller names none", () => {
    const run = load("COMPOSE_PROJECT=staging\n");
    expect(run.status, run.stderr).toBe(0);
    expect(run.vars).toEqual(["COMPOSE_PROJECT=staging"]);
  });

  it("refuses a file for project infra when the caller deploys another project", () => {
    const run = load(
      "COMPOSE_PROJECT=infra\nSMOKE_URL=https://prod.test\n",
      "export COMPOSE_PROJECT=b12i-staging",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("it is for compose project infra, not b12i-staging");
  });

  it.skipIf(!POSIX_MODES)("refuses a file group or others can write", () => {
    const run = load("COMPOSE_PROJECT=infra\n", 'chmod 664 "$T/checkout/infra/deploy.env"');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("writable by group or others (mode 664)");
  });

  it.skipIf(!POSIX_MODES)("refuses a symlink to something that is not a regular file", () => {
    const run = load(null, 'ln -s "$T" "$T/checkout/infra/deploy.env"');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("not a regular file");
  });
});
