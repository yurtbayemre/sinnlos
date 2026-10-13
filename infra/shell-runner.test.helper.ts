/**
 * Where the infra shell tests run a bash harness (a script on stdin, as in
 * deploy-flow.test.ts): natively, or in a Linux container.
 *
 * The scripts under test run on Linux hosts and rely on what Git Bash on
 * Windows lacks or fakes: flock (util-linux), file modes (NTFS shows every
 * file as 644, so a mode-600 check cannot pass) and, for the backup-run drill,
 * zstd. So a harness that needs them runs:
 *   - natively when this is not Windows and every tool it needs is there
 *     (CI's ubuntu runner: bash, flock, openssl, docker, zstd; age only when
 *     installed);
 *   - else in the image SINNLOS_SHELL_RUNNER_IMAGE names, with the Docker
 *     socket mounted (`docker run -i --rm … bash -s`), for example built
 *     with
 *       docker build -t sinnlos-shell-runner - <<'EOF'
 *       FROM alpine:3.20
 *       RUN apk add --no-cache bash util-linux openssl coreutils git tar gzip \
 *             grep sed findutils mawk age zstd docker-cli docker-cli-compose \
 *        && ln -sf /usr/bin/mawk /usr/bin/awk
 *       EOF
 *     (mawk, as on Ubuntu hosts);
 *   - else not at all (the suite is skipped, and says why).
 * The harness carries the script under test inside its own text (a quoted
 * heredoc), so nothing is mounted but the Docker socket.
 */
import { spawnSync } from "node:child_process";

export type ShellMode = "native" | "runner";

export interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}

const RUNNER_IMAGE = process.env.SINNLOS_SHELL_RUNNER_IMAGE ?? "";

/** True when `command -v` finds every tool in a native bash. */
function nativeHas(tools: readonly string[]): boolean {
  const probe = tools.map((t) => `command -v ${t} >/dev/null 2>&1`).join(" && ");
  return spawnSync("bash", ["-c", probe || "true"]).status === 0;
}

/** True when the runner image exists locally and has every tool. */
function runnerHas(tools: readonly string[]): boolean {
  if (!RUNNER_IMAGE) return false;
  const probe = tools.map((t) => `command -v ${t} >/dev/null 2>&1`).join(" && ");
  const res = spawnSync("docker", ["run", "--rm", RUNNER_IMAGE, "bash", "-c", probe || "true"], {
    encoding: "utf8",
  });
  return res.status === 0;
}

/**
 * Where a harness that needs `tools` (and, with `linux`, Linux file modes)
 * can run, or null. Probed once per call site; cheap enough for a suite's
 * module scope.
 */
export function shellMode(tools: readonly string[], opts: { linux: boolean }): ShellMode | null {
  const linuxOk = process.platform !== "win32" || !opts.linux;
  if (linuxOk && nativeHas(["bash", ...tools])) return "native";
  if (runnerHas(["bash", ...tools])) return "runner";
  return null;
}

/** Why a suite was skipped, for its title. */
export function skipReason(tools: readonly string[]): string {
  return `needs bash with ${tools.join(", ")} and Linux file modes; on Windows set SINNLOS_SHELL_RUNNER_IMAGE (infra/shell-runner.test.helper.ts)`;
}

/**
 * Runs a bash script natively or in the runner image. The script goes to a
 * file first and runs with stdin from /dev/null: a `docker exec -i` or a
 * `compose exec` in it would otherwise read the rest of the script.
 */
export function runBash(
  script: string,
  mode: ShellMode,
  opts: { timeout?: number; env?: Record<string, string> } = {},
): ShellResult {
  const timeout = opts.timeout ?? 600_000;
  const wrapped = [
    'SINNLOS_HARNESS="$(mktemp)"',
    "cat > \"$SINNLOS_HARNESS\" <<'__SINNLOS_HARNESS_EOF__'",
    script,
    "__SINNLOS_HARNESS_EOF__",
    'bash "$SINNLOS_HARNESS" < /dev/null',
    "rc=$?",
    'rm -f "$SINNLOS_HARNESS"',
    'exit "$rc"',
    "",
  ].join("\n");
  const res =
    mode === "native"
      ? spawnSync("bash", ["-s"], {
          input: wrapped,
          encoding: "utf8",
          timeout,
          env: { ...process.env, ...opts.env },
          maxBuffer: 64 * 1024 * 1024,
        })
      : spawnSync(
          "docker",
          [
            "run",
            "-i",
            "--rm",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
            RUNNER_IMAGE,
            "bash",
            "-s",
          ],
          { input: wrapped, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 },
        );
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Docker reachable from where the harness runs (the runner always mounts the socket). */
export function dockerReachable(mode: ShellMode | null): boolean {
  if (mode === null) return false;
  if (mode === "runner") return true;
  return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"]).status === 0;
}
