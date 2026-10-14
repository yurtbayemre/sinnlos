/**
 * infra/diagnostics/census.sh, run in bash with docker stubbed as an
 * exported shell function that records its calls: the containers it reads
 * follow COMPOSE_PROJECT like infra/deploy.sh (production's `infra` by
 * default, a staging copy's own project otherwise), and a project name
 * docker could not have refuses before any docker call. The script runs
 * from its own directory (cwd), so no Windows path crosses into bash.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;
/** Bash starts are slow under a parallel run on Windows (docs/architecture.md §5.40). */
const BASH_BUDGET = { timeout: 60_000 };

const STUB = [
  'docker() { echo "docker $*" >&2; if [ "$1" = exec ] && [ "$2" = -i ]; then cat >/dev/null; fi; return 0; }',
  "export -f docker",
  "bash census.sh",
].join("\n");

function census(project: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.COMPOSE_PROJECT;
  if (project !== undefined) env.COMPOSE_PROJECT = project;
  const res = spawnSync("bash", ["-c", STUB], { cwd: HERE, env, encoding: "utf8" });
  const calls = res.stderr.split("\n").filter((line) => line.startsWith("docker "));
  return { status: res.status, calls, stderr: res.stderr };
}

/** The container each docker call names (its last argument, or exec's first). */
const containers = (calls: string[]) =>
  [
    ...new Set(
      calls.map((call) => {
        const args = call.split(" ").slice(1);
        if (args[0] === "exec") return args[args[1] === "-i" ? 2 : 1];
        return args[args.length - 1];
      }),
    ),
  ].sort();

describe.skipIf(!HAS_BASH)("census.sh: the containers of the compose project", BASH_BUDGET, () => {
  it("reads production's infra-db-1 and infra-cms-1 by default", () => {
    const run = census(undefined);
    expect(run.status, run.stderr).toBe(0);
    expect(containers(run.calls)).toEqual(["infra-cms-1", "infra-db-1"]);
  });

  it("follows COMPOSE_PROJECT like deploy.sh", () => {
    const run = census("b12i-staging");
    expect(run.status, run.stderr).toBe(0);
    expect(containers(run.calls)).toEqual(["b12i-staging-cms-1", "b12i-staging-db-1"]);
  });

  it("refuses a project name docker could not have, before any docker call", () => {
    const run = census("Infra; rm");
    expect(run.status).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain("COMPOSE_PROJECT must be a compose project name");
  });
});
