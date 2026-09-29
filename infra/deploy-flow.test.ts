/**
 * infra/deploy.sh end to end (FX35), in bash against a throwaway git
 * checkout, with docker, curl, flock and timeout stubbed as exported shell
 * functions: docker keeps its images, tags and containers in files, so
 * tags, the last-known-good state and the rollback target can be followed
 * across a sequence of deploys. Pinned:
 *   1. SHA tags and the state are written only after the smoke check and
 *      live-smoke passed; the state names the images web and cms run;
 *   2. the rollback target comes from that state (no :rollback retag); only
 *      without a state (the first run of this version) are the running
 *      images tagged :rollback, and re-runs keep that :rollback until a
 *      deploy is recorded (the bootstrap marker);
 *   3. a failed smoke check, live-smoke, build, start or tag prints the
 *      right message (the rollback commands from "start" on) and leaves the
 *      state alone;
 *   4. flock, the clean-tree check and the CI check (warning by default,
 *      refusal with --require-green-ci; a token never on curl's command
 *      line) stop a deploy before anything is touched;
 *   5. --dry-run changes nothing; --check stays the env preflight; SHA tags
 *      beyond DEPLOY_KEEP_TAGS go, images and history;
 *   6. the pre-deploy backup runs as SINNLOS_BACKUP_KIND=predeploy, and the
 *      compose project, smoke URL and checkout are parameters; the smoke
 *      URL defaults to https://<DOMAIN>, the host of the rendered router
 *      rules, and --check refuses the example DOMAIN (5A-T1);
 *   7. on the containerd image store (an image no tag references cannot be
 *      resolved), the running images keep a :pre-deploy tag through the
 *      build, so a re-run after a failed deploy records what runs, and a
 *      running image that cannot be resolved stops `record` before any tag;
 *   8. without a state, a running image that cannot be tagged :rollback
 *      (next to an older :rollback of that service) or a bootstrap marker
 *      that cannot be written stops the run before the build, and a dry run
 *      says it would stop (B10-T2).
 * Each sequence runs in one bash process. Git Bash forks slowly (a stubbed
 * deploy costs about 6 s there, both sequences about 100 s), so on Windows
 * the two sequences run only with SINNLOS_SLOW_SHELL_TESTS=1; CI (Linux)
 * and every other platform run them always. The preflight, the rollback
 * hint's special cases and live-smoke's switches are pinned in
 * apps/cms/src/utils/deploy-preflight.test.ts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const DEPLOY = readFileSync(new URL("./deploy.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const HAS_GIT = spawnSync("git", ["--version"]).status === 0;
const SLOW_SHELL = process.platform === "win32" && process.env.SINNLOS_SLOW_SHELL_TESTS !== "1";
const RUN_SEQUENCES = HAS_BASH && HAS_GIT && !SLOW_SHELL;
const SEQUENCE_BUDGET = 300_000;

/** One deploy.sh run of a sequence. */
interface Step {
  /** Bash run before deploy.sh (the harness variables and helpers are in scope). */
  before?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface StepReport {
  status: number;
  stdout: string;
  stderr: string;
  /** docker/curl calls of this run, one per line. */
  calls: string[];
  /** What curl read on stdin (the CI check's --config). */
  curlStdin: string;
  /** The state file of compose project infra after the run (empty without one). */
  state: Record<string, string>;
  history: string[];
  /** The lines of the bootstrap marker (infra.bootstrap) after the run. */
  bootstrap: string[];
  /** Every image reference docker knows after the run, "name:tag=id". */
  images: string[];
  /** Whether the state dir exists after the run. */
  stateDir: boolean;
}

/** The host the stub instance's Traefik routers and public URLs name (DOMAIN). */
const STUB_HOST = "intranet.acme.test";

/** `docker compose config --format json` of the stub instance, with `host` as DOMAIN. */
const composeJson = (host: string) =>
  JSON.stringify(
    {
      services: {
        cms: {
          environment: {
            LIVE_EVENTS_DISABLED: "0",
            ENTRA_ENABLED: "0",
            AUTH_LOCAL_ENABLED: "0",
            PUBLIC_URL: `https://${host}`,
          },
          labels: {
            "traefik.http.routers.sinnlos-cms.rule": `Host(\`${host}\`) && PathPrefix(\`/api\`)`,
          },
        },
        web: {
          environment: { AUTH_URL: `https://${host}` },
          labels: { "traefik.http.routers.sinnlos-web.rule": `Host(\`${host}\`)` },
        },
      },
    },
    null,
    2,
  );
const COMPOSE_JSON = composeJson(STUB_HOST);

/**
 * Runs the steps in one bash process, in a fresh checkout ($REPO, one
 * commit) with the real deploy.sh and stub backup/live-smoke scripts.
 * Helpers for `before`: `commit` (a new empty commit), `running <web-id>
 * <cms-id>` (containers that run already), `ci <json-body>` (the GitHub
 * check-runs answer), KEEP (DEPLOY_KEEP_TAGS), and the STUB_* switches
 * (STUB_SMOKE_CODE, STUB_LIVE_RC, STUB_BUILD_FAIL, STUB_UP_FAIL,
 * STUB_TAG_FAIL, STUB_LOCK_HELD, STUB_STATE_WRITE_FAIL,
 * STUB_BOOTSTRAP_WRITE_FAIL; STUB_CONTAINERD: an image id resolves only
 * while a tag references it, as on the containerd image store, else once it
 * was built or ran; STUB_UP_KEEP: `up` keeps the containers that exist, as
 * compose does for unchanged content). Every build is a new image id.
 */
function deploys(steps: readonly Step[]): StepReport[] {
  const script: string[] = [
    "set -uo pipefail",
    'T="$(mktemp -d)"',
    "trap 'rm -rf \"$T\"' EXIT",
    'REPO="$T/checkout"',
    'mkdir -p "$REPO/infra/backup" "$REPO/infra/rollback" "$T/img" "$T/ctr"',
    'echo 0 > "$T/n"',
    "cat > \"$REPO/infra/deploy.sh\" <<'DEPLOY_SH_EOF'",
    DEPLOY.trimEnd(),
    "DEPLOY_SH_EOF",
    ': > "$REPO/infra/docker-compose.yml"',
    ': > "$REPO/infra/docker-compose.traefik.yml"',
    ': > "$REPO/infra/rollback/revoke-guest-poll-vote.sql"',
    `printf '#!/usr/bin/env bash\\necho "backup kind=$SINNLOS_BACKUP_KIND db=$SINNLOS_DB_CONTAINER dir=\${SINNLOS_BACKUP_DIR:-default} quick=\${SINNLOS_LOCAL_ENV_BACKUP:-default}"\\n' > "$REPO/infra/backup/pg-backup.sh"`,
    `printf '#!/usr/bin/env bash\\necho "live-smoke base=$BASE_URL cms=$CMS_CONTAINER"\\n' > "$REPO/infra/live-smoke.sh"`,
    // With STUB_LIVE_NOFRAME: the line live-smoke prints when the stream user owns no announcement.
    `printf 'if [[ -n "\${STUB_LIVE_NOFRAME:-}" ]]; then echo "live-smoke: WARNING - the notification frame path was not checked: stub"; fi\\nexit "\${STUB_LIVE_RC:-0}"\\n' >> "$REPO/infra/live-smoke.sh"`,
    'chmod +x "$REPO/infra/deploy.sh" "$REPO/infra/backup/pg-backup.sh" "$REPO/infra/live-smoke.sh"',
    "cat > \"$T/compose.json\" <<'COMPOSE_JSON'",
    COMPOSE_JSON,
    "COMPOSE_JSON",
    // The same instance with the example DOMAIN of infra/.env.example.
    "cat > \"$T/compose-example.json\" <<'COMPOSE_JSON'",
    composeJson("intranet.example.com"),
    "COMPOSE_JSON",
    // A throwaway repo: identity and line endings on the command line only.
    'G=(git -C "$REPO" -c user.name=deploy-test -c user.email=deploy-test@example.invalid -c commit.gpgsign=false -c core.autocrlf=false -c core.safecrlf=false -c init.defaultBranch=main -c core.hooksPath=/dev/null)',
    '"${G[@]}" init -q',
    '"${G[@]}" add -A',
    '"${G[@]}" commit -q -m "first"',
    'commit() { "${G[@]}" commit -q --allow-empty -m "next"; }',
    'running() { echo "$1" > "$T/ctr/infra-web-1"; echo "$2" > "$T/ctr/infra-cms-1"; printf "%s\\n%s\\n" "$1" "$2" >> "$T/ids"; }',
    'ci() { printf "%s\\n" "$1" > "$T/ci.json"; STUB_CI="$T/ci.json"; }',
    "KEEP=5",
    // The demo credentials file deploy.sh checks before it runs live-smoke.
    'echo "casey.jones@sinnlos.local pw" > "$T/passwords"',
    'export PASSWORDS_FILE="$T/passwords"',
    "export T STUB_SMOKE_CODE=200 STUB_LIVE_RC=0 STUB_LIVE_NOFRAME= STUB_BUILD_FAIL= STUB_UP_FAIL= STUB_TAG_FAIL= STUB_LOCK_HELD= STUB_CI= STUB_NO_VOLUMES= STUB_CONTAINERD= STUB_UP_KEEP= STUB_STATE_WRITE_FAIL= STUB_BOOTSTRAP_WRITE_FAIL=",
    // Whether an image id resolves: on containerd only while a tag names it.
    "resolvable() {",
    // (No pipe: under deploy.sh's pipefail, grep -q ending early could fail cat.)
    '  if [[ -n "$STUB_CONTAINERD" ]]; then grep -qxF "$1" "$T"/img/* 2> /dev/null; else grep -qxF "$1" "$T/ids" 2> /dev/null; fi',
    "}",
    // docker keeps images in $T/img/<name>__<tag> and containers in $T/ctr.
    "docker() {",
    '  printf \'docker %s\\n\' "$*" >> "$T/calls"',
    '  local a sub="" ref id p=infra prev=""',
    '  case "$1" in',
    "    compose)",
    '      for a in "$@"; do',
    '        if [[ "$prev" == -p ]]; then p="$a"; fi; prev="$a"',
    '        case "$a" in config|build|up) sub="$a"; break ;; esac',
    "      done",
    '      case "$sub" in',
    '        config) if [[ "$*" == *"--format json"* ]]; then cat "$T/compose.json"; fi ;;',
    "        build)",
    '          echo "build-env BUILDX_NO_DEFAULT_ATTESTATIONS=${BUILDX_NO_DEFAULT_ATTESTATIONS:-unset}" >> "$T/calls"',
    '          [[ -z "$STUB_BUILD_FAIL" ]] || return 1',
    '          id=$(( $(cat "$T/n") + 1 )); echo "$id" > "$T/n"',
    '          echo "sha256:web$id" > "$T/img/$p-web__latest"; echo "sha256:cms$id" > "$T/img/$p-cms__latest"',
    '          printf "sha256:web%s\\nsha256:cms%s\\n" "$id" "$id" >> "$T/ids" ;;',
    "        up)",
    '          [[ -z "$STUB_UP_FAIL" ]] || return 1',
    "          for a in web cms; do",
    '            if [[ -z "$STUB_UP_KEEP" || ! -f "$T/ctr/$p-$a-1" ]]; then cp "$T/img/$p-${a}__latest" "$T/ctr/$p-$a-1"; fi',
    "          done ;;",
    "      esac ;;",
    "    inspect)",
    '      ref="${*: -1}"',
    '      if [[ "$*" == *"org.sinnlos.strapi-jwt"* ]]; then [[ -f "$T/ctr/$ref" ]] || return 1; echo server-only; return 0; fi',
    '      [[ -f "$T/ctr/$ref" ]] || return 1; cat "$T/ctr/$ref" ;;',
    "    image)",
    '      case "$2" in',
    "        inspect)",
    '          ref="${*: -1}"',
    '          if [[ "$ref" == sha256:* ]]; then resolvable "$ref"; return; fi',
    '          [[ -f "$T/img/${ref//:/__}" ]] || return 1',
    '          if [[ "$*" == *"{{.Id}}"* ]]; then cat "$T/img/${ref//:/__}"; elif [[ "$*" == *org.sinnlos.datetime* ]]; then echo zone-explicit; elif [[ "$*" == *Config.Cmd* ]]; then echo \'["node_modules/.bin/strapi","start"]\'; fi ;;',
    '        rm) shift 2; for ref in "$@"; do rm -f "$T/img/${ref//:/__}"; done ;;',
    "      esac ;;",
    "    tag)",
    '      [[ -z "$STUB_TAG_FAIL" ]] || return 1',
    '      if [[ "$2" == sha256:* ]]; then',
    '        resolvable "$2" || { echo "Error response from daemon: No such image: $2" >&2; return 1; }',
    '        id="$2"',
    '      else [[ -f "$T/img/${2//:/__}" ]] || return 1; id="$(cat "$T/img/${2//:/__}")"; fi',
    '      echo "$id" > "$T/img/${3//:/__}" ;;',
    "    exec) cat > /dev/null; echo 0 ;;",
    '    volume) [[ -z "$STUB_NO_VOLUMES" ]] ;;',
    // ps -aq --filter label=com.docker.compose.project=<p>: containers <p>-<svc>-1.
    "    ps)",
    '      for ref in "$T"/ctr/*; do',
    '        ref="${ref##*/}"',
    '        if [[ -e "$T/ctr/$ref" && "$*" == *"com.docker.compose.project=${ref%-*-1}" ]]; then echo "$ref"; fi',
    "      done ;;",
    "    run) return 0 ;;",
    "  esac",
    "}",
    "curl() {",
    '  printf \'curl %s\\n\' "$*" >> "$T/calls"',
    '  if [[ "$*" == *api.github.com* ]]; then',
    '    cat > "$T/curl-stdin"',
    '    [[ -n "$STUB_CI" ]] || { echo "curl: (22) The requested URL returned error: 404"; return 22; }',
    '    cat "$STUB_CI"; return 0',
    "  fi",
    "  printf '%s' \"$STUB_SMOKE_CODE\"",
    "}",
    'flock() { [[ -z "$STUB_LOCK_HELD" ]]; }',
    'timeout() { while [[ "$1" != docker ]]; do shift; done; "$@"; }',
    "sleep() { :; }",
    // STUB_STATE_WRITE_FAIL / STUB_BOOTSTRAP_WRITE_FAIL: the state file or the
    // bootstrap marker cannot be written (its mv fails).
    "mv() {",
    '  if [[ -n "$STUB_STATE_WRITE_FAIL" && "${*: -1}" == *.state ]] || [[ -n "$STUB_BOOTSTRAP_WRITE_FAIL" && "${*: -1}" == *.bootstrap ]]; then',
    '    echo "mv: No space left on device" >&2; return 1',
    "  fi",
    '  command mv "$@"',
    "}",
    "export -f docker curl flock timeout sleep resolvable mv",
  ];
  steps.forEach((step, n) => {
    const env = Object.entries(step.env ?? {})
      .map(([key, value]) => `${key}='${value.replace(/'/g, `'\\''`)}'`)
      .join(" ");
    const args = (step.args ?? []).map((a) => `'${a}'`).join(" ");
    script.push(
      ': > "$T/calls"; rm -f "$T/curl-stdin"',
      step.before ?? "",
      `(cd "$T" && env ${env} DEPLOY_KEEP_TAGS="$KEEP" bash "$REPO/infra/deploy.sh" ${args} > "$T/out" 2> "$T/err"); rc=$?`,
      `echo "@@STEP ${n} $rc"`,
      'sed "s/^/@@OUT /" "$T/out"',
      'sed "s/^/@@ERR /" "$T/err"',
      'sed "s/^/@@CALL /" "$T/calls"',
      'if [[ -f "$T/curl-stdin" ]]; then sed "s/^/@@STDIN /" "$T/curl-stdin"; fi',
      'S="$REPO/.git/sinnlos-deploy"',
      'if [[ -d "$S" ]]; then echo "@@STATEDIR"; fi',
      'if [[ -f "$S/infra.state" ]]; then sed "s/^/@@STATE /" "$S/infra.state"; fi',
      'if [[ -f "$S/infra.history" ]]; then sed "s/^/@@HIST /" "$S/infra.history"; fi',
      'if [[ -f "$S/infra.bootstrap" ]]; then sed "s/^/@@BOOT /" "$S/infra.bootstrap"; fi',
      'for f in "$T"/img/*; do if [[ -e "$f" ]]; then r="${f##*/}"; echo "@@IMG ${r/__/:}=$(< "$f")"; fi; done',
    );
  });
  script.push("");
  const res = spawnSync("bash", ["-s"], { input: script.join("\n"), encoding: "utf8" });
  expect(res.stderr, "harness stderr").toBe("");
  const reports: StepReport[] = [];
  let current: StepReport | null = null;
  for (const line of res.stdout.split("\n")) {
    const step = /^@@STEP (\d+) (\d+)$/.exec(line);
    if (step) {
      current = {
        status: Number(step[2]),
        stdout: "",
        stderr: "",
        calls: [],
        curlStdin: "",
        state: {},
        history: [],
        images: [],
        stateDir: false,
        bootstrap: [],
      };
      reports.push(current);
      continue;
    }
    if (!current) continue;
    const [tag, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (tag === "@@OUT") current.stdout += `${value}\n`;
    else if (tag === "@@ERR") current.stderr += `${value}\n`;
    else if (tag === "@@CALL") current.calls.push(value);
    else if (tag === "@@STDIN") current.curlStdin += `${value}\n`;
    else if (tag === "@@STATEDIR") current.stateDir = true;
    else if (tag === "@@BOOT") current.bootstrap.push(value);
    else if (tag === "@@STATE" && !value.startsWith("#")) {
      const eq = value.indexOf("=");
      current.state[value.slice(0, eq)] = value.slice(eq + 1);
    } else if (tag === "@@HIST") current.history.push(value);
    else if (tag === "@@IMG") current.images.push(value);
  }
  expect(reports).toHaveLength(steps.length);
  return reports;
}

const tagOf = (report: StepReport) => report.state.TAG;
const called = (report: StepReport, pattern: RegExp) => report.calls.filter((c) => pattern.test(c));
const historyTags = (report: StepReport) => report.history.map((line) => line.split(" ")[0]);

describe.skipIf(!RUN_SEQUENCES)(
  "deploy.sh: last-known-good state, SHA tags and failures (FX35)",
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = deploys([
        /* 0 */ { before: "STUB_NO_VOLUMES=1" },
        /* 1 */ { before: "STUB_NO_VOLUMES=; commit; STUB_SMOKE_CODE=502" },
        /* 2 */ { before: "STUB_SMOKE_CODE=200; STUB_LIVE_RC=1" },
        /* 3 */ { before: "STUB_LIVE_RC=0; STUB_TAG_FAIL=1" },
        /* 4 */ { before: "STUB_TAG_FAIL=; STUB_BUILD_FAIL=1" },
        /* 5 */ { before: "STUB_BUILD_FAIL=; STUB_UP_FAIL=1" },
        /* 6 */ { before: "STUB_UP_FAIL=; KEEP=2" },
        /* 7 */ { before: "commit" },
        /* 8 */ { before: "commit; STUB_LIVE_NOFRAME=1" },
        // No demo credentials: live-smoke is skipped, and nothing is recorded …
        /* 9 */ {
          before: "commit; STUB_LIVE_NOFRAME=",
          env: { PASSWORDS_FILE: "/nonexistent/pw" },
        },
        // … unless asked to.
        /* 10 */ {
          env: { PASSWORDS_FILE: "/nonexistent/pw" },
          args: ["--record-without-live-smoke"],
        },
        // The state cannot be written, with DEPLOY_KEEP_TAGS=1 …
        /* 11 */ { before: "commit; KEEP=1; STUB_STATE_WRITE_FAIL=1" },
        // … and the next deploy still finds the previous one.
        /* 12 */ { before: "commit; STUB_STATE_WRITE_FAIL=" },
      ]);
    }, SEQUENCE_BUDGET);

    it("records the images after the smoke check and live-smoke, and tags them by commit", () => {
      const first = r[0];
      expect(first.status, first.stderr).toBe(0);
      // A first install (no db container, no database volume) has nothing to back up …
      expect(first.stdout).toContain(
        "first install: neither infra-db-1 nor the volume infra_pgdata exists, nothing to back up",
      );
      expect(first.stdout).not.toContain("backup kind=");
      // … every later deploy does, as a pre-deploy backup.
      expect(r[6].stdout).toContain("backup kind=predeploy db=infra-db-1");
      // The smoke URL follows DOMAIN (the host of every router).
      expect(first.stdout).toContain(`Traefik host: ${STUB_HOST}; smoke URL: https://${STUB_HOST}`);
      expect(first.stdout).toContain(`live-smoke base=https://${STUB_HOST} cms=infra-cms-1`);
      expect(called(first, /^curl /).filter((c) => !c.includes("api.github.com"))).toEqual([
        `curl -sS -o /dev/null -w %{http_code} --max-time 15 https://${STUB_HOST}`,
      ]);
      expect(first.stdout).toContain("none: nothing ran here before (first install)");
      expect(first.state).toMatchObject({
        WEB_IMAGE: "sha256:web1",
        CMS_IMAGE: "sha256:cms1",
        LIVE_SMOKE: "passed",
      });
      expect(first.state.SHA).toMatch(/^[0-9a-f]{40}$/);
      expect(tagOf(first)).toBe(first.state.SHA.slice(0, 12));
      expect(first.images).toEqual(
        expect.arrayContaining([
          `infra-web:${tagOf(first)}=sha256:web1`,
          `infra-cms:${tagOf(first)}=sha256:cms1`,
        ]),
      );
      expect(historyTags(first)).toEqual([tagOf(first)]);
      // build, then up without a build, then the tags.
      const order = first.calls.filter((c) => / (build|up -d --no-build)$|^docker tag /.test(c));
      expect(order).toEqual([
        expect.stringMatching(/ build$/),
        expect.stringMatching(/ up -d --no-build$/),
        `docker tag sha256:web1 infra-web:${tagOf(first)}`,
        `docker tag sha256:cms1 infra-cms:${tagOf(first)}`,
      ]);
    });

    it("rolls back to the state after a failed smoke check, and tags nothing", () => {
      const [good, bad] = r;
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain(`last-known-good: infra-{web,cms}:${tagOf(good)}`);
      expect(called(bad, /:rollback/)).toEqual([]);
      expect(bad.stderr).toContain("smoke check failed");
      expect(bad.stderr).toContain(`docker tag infra-web:${tagOf(good)} infra-web:latest`);
      expect(bad.stderr).toContain(`docker tag infra-cms:${tagOf(good)} infra-cms:latest`);
      expect(bad.stderr).toContain("up -d --no-build web cms");
      expect(bad.state).toEqual(good.state);
      expect(bad.history).toEqual(good.history);
      expect(bad.images.filter((i) => i.endsWith("=sha256:web2"))).toEqual([
        "infra-web:latest=sha256:web2",
      ]);
    });

    it("does not record a deploy whose live-smoke failed, and prints the rollback", () => {
      const bad = r[2];
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("live-smoke failed");
      expect(bad.stderr).toContain("This deploy is NOT recorded as last-known-good");
      expect(bad.stderr).toContain(`docker tag infra-web:${tagOf(r[0])} infra-web:latest`);
      expect(bad.state).toEqual(r[0].state);
    });

    it("prints the rollback for a failed tag (ERR trap), and keeps the state", () => {
      const bad = r[3];
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("infra/deploy.sh failed during 'record'");
      expect(bad.stderr).toContain(`docker tag infra-web:${tagOf(r[0])} infra-web:latest`);
      expect(bad.state).toEqual(r[0].state);
    });

    it("says the containers are untouched when the build fails (ERR trap)", () => {
      const bad = r[4];
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("infra/deploy.sh failed during 'build'");
      expect(bad.stderr).toContain("The running containers are untouched");
      expect(bad.stderr).not.toContain("docker tag");
      expect(called(bad, / up -d/)).toEqual([]);
      expect(bad.state).toEqual(r[0].state);
    });

    it("prints the compose-up hint with the state's target when the new stack does not start", () => {
      const bad = r[5];
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("docker compose up failed");
      expect(bad.stderr).toContain(`To roll back to the last-known-good deploy ${tagOf(r[0])}`);
      expect(bad.state).toEqual(r[0].state);
    });

    it("records a live-smoke that could not check the notification frame, with a warning", () => {
      const run = r[8];
      expect(run.status, run.stderr).toBe(0);
      // live-smoke's own output still reaches the terminal (tee).
      expect(run.stdout).toContain(
        "live-smoke: WARNING - the notification frame path was not checked",
      );
      expect(run.stderr).toContain("WARNING: live-smoke did not check the notification frame path");
      expect(run.state.LIVE_SMOKE).toBe("passed (notification frame not checked)");
      expect(tagOf(run)).not.toBe(tagOf(r[7]));
      expect(r[7].state.LIVE_SMOKE).toBe("passed");
    });

    it("records nothing when live-smoke lacked the demo credentials, unless told to", () => {
      const [before, skipped, forced] = [r[8], r[9], r[10]];
      expect(skipped.status, skipped.stderr).toBe(0);
      expect(skipped.stdout).toContain("live-smoke SKIPPED: demo credentials file /nonexistent/pw");
      expect(skipped.stderr).toContain(
        "WARNING: live-smoke did not run; this deploy is NOT recorded as last-known-good",
      );
      expect(skipped.stdout).toContain("Deploy complete, NOT recorded as last-known-good.");
      expect(skipped.state).toEqual(before.state);
      expect(skipped.history).toEqual(before.history);
      expect(
        called(skipped, /^docker tag \S+ infra-(web|cms):[0-9a-f]{12}$|^docker image rm/),
      ).toEqual([]);
      expect(forced.status, forced.stderr).toBe(0);
      expect(forced.state.SHA).not.toBe(before.state.SHA);
      expect(forced.state.LIVE_SMOKE).toMatch(
        /^skip: demo credentials file \/nonexistent\/pw not readable/,
      );
    });

    it("prunes nothing when the state cannot be written, so the state's tags stay", () => {
      const [good, unwritten, next] = [r[10], r[11], r[12]];
      const orphan = historyTags(unwritten).at(-1) ?? "";
      expect(unwritten.status, unwritten.stderr).toBe(0);
      expect(unwritten.stderr).toContain(`WARNING: could not write `);
      expect(unwritten.stderr).toContain("no SHA tag is pruned");
      expect(called(unwritten, /^docker image rm/)).toEqual([]);
      expect(unwritten.state).toEqual(good.state);
      // Its own tag is in the history (a later prune removes it), the state's stays.
      expect(orphan).not.toBe(tagOf(good));
      expect(historyTags(unwritten)).toEqual([...historyTags(good), orphan]);
      expect(unwritten.images).toEqual(
        expect.arrayContaining([
          `infra-web:${tagOf(good)}=${good.state.WEB_IMAGE}`,
          `infra-cms:${tagOf(good)}=${good.state.CMS_IMAGE}`,
        ]),
      );
      // The next deploy rolls back to that state, not to a :rollback fallback …
      expect(next.status, next.stderr).toBe(0);
      expect(next.stdout).toContain(`last-known-good: infra-{web,cms}:${tagOf(good)}`);
      expect(called(next, /:rollback$/)).toEqual([]);
      // … and with KEEP=1 prunes both older tags once its own state is written.
      expect(historyTags(next)).toEqual([tagOf(next)]);
      expect(next.stdout).toContain(`pruned infra-{web,cms}:${tagOf(good)}`);
      expect(next.stdout).toContain(`pruned infra-{web,cms}:${orphan}`);
    });

    it("moves the state on the next good deploy, and prunes SHA tags beyond DEPLOY_KEEP_TAGS", () => {
      const [first, , , , , , second, third] = r;
      expect(second.status, second.stderr).toBe(0);
      expect(third.status, third.stderr).toBe(0);
      expect(tagOf(second)).not.toBe(tagOf(first));
      expect(historyTags(second)).toEqual([tagOf(first), tagOf(second)]);
      // KEEP=2: the third deploy drops the first one's tags, images and history.
      expect(historyTags(third)).toEqual([tagOf(second), tagOf(third)]);
      expect(third.stdout).toContain(`pruned infra-{web,cms}:${tagOf(first)}`);
      expect(third.images.filter((i) => i.includes(`:${tagOf(first)}=`))).toEqual([]);
      expect(third.images).toEqual(
        expect.arrayContaining([
          `infra-web:${tagOf(second)}=${second.state.WEB_IMAGE}`,
          `infra-web:${tagOf(third)}=${third.state.WEB_IMAGE}`,
        ]),
      );
    });
  },
);

describe.skipIf(!RUN_SEQUENCES)(
  "deploy.sh on the containerd image store: a re-run after a failed deploy (FX35)",
  () => {
    let r: StepReport[] = [];
    const newTagCalls = (report: StepReport) =>
      called(report, /^docker tag \S+ infra-(web|cms):[0-9a-f]{12}$/);
    beforeAll(() => {
      r = deploys([
        /* 0 */ { before: "STUB_CONTAINERD=1" },
        // Fails after `up`: web2/cms2 run, only :latest names them.
        /* 1 */ { before: "commit; STUB_SMOKE_CODE=502" },
        // The re-run of that commit: its build moves :latest to web3/cms3,
        // and compose keeps the running containers.
        /* 2 */ { before: "STUB_SMOKE_CODE=200; STUB_UP_KEEP=1" },
        // Containers that run images no tag names (and never did).
        /* 3 */ { before: "commit; running sha256:ghostweb sha256:ghostcms" },
      ]);
    }, SEQUENCE_BUDGET);

    it("keeps the running images tagged :pre-deploy through the build, so the re-run records them", () => {
      const [first, failed, rerun] = r;
      expect(first.status, first.stderr).toBe(0);
      expect(failed.status).toBe(1);
      expect(failed.state).toEqual(first.state);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(rerun.state).toMatchObject({ WEB_IMAGE: "sha256:web2", CMS_IMAGE: "sha256:cms2" });
      expect(tagOf(rerun)).not.toBe(tagOf(first));
      const order = rerun.calls.filter((c) => / build$|^docker tag |^build-env /.test(c));
      expect(order).toEqual([
        "docker tag sha256:web2 infra-web:pre-deploy",
        "docker tag sha256:cms2 infra-cms:pre-deploy",
        expect.stringMatching(/ build$/),
        "build-env BUILDX_NO_DEFAULT_ATTESTATIONS=1",
        `docker tag sha256:web2 infra-web:${tagOf(rerun)}`,
        `docker tag sha256:cms2 infra-cms:${tagOf(rerun)}`,
      ]);
      expect(rerun.images).toEqual(
        expect.arrayContaining([
          "infra-web:latest=sha256:web3",
          "infra-web:pre-deploy=sha256:web2",
          `infra-web:${tagOf(rerun)}=sha256:web2`,
          `infra-cms:${tagOf(rerun)}=sha256:cms2`,
        ]),
      );
    });

    it("stops `record` before any tag when a running image cannot be resolved", () => {
      const [, , good, bad] = r;
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain(
        "WARNING: could not tag sha256:ghostweb (infra-web-1) as infra-web:pre-deploy",
      );
      expect(bad.stderr).toContain(
        "the image sha256:ghostweb that infra-web-1 or infra-cms-1 runs",
      );
      expect(bad.stderr).toContain("up -d --no-build --force-recreate web cms");
      expect(bad.stderr).toContain("infra/deploy.sh failed during 'record'");
      expect(bad.stderr).toContain(`docker tag infra-web:${tagOf(good)} infra-web:latest`);
      expect(newTagCalls(bad)).toEqual([]);
      expect(bad.state).toEqual(good.state);
      expect(bad.history).toEqual(good.history);
    });
  },
);

describe.skipIf(!RUN_SEQUENCES)(
  "deploy.sh before its first recorded deploy: the first run's :rollback stays (FX35)",
  () => {
    let r: StepReport[] = [];
    beforeAll(() => {
      r = deploys([
        // The first run: the images from before run, no state; it fails after `up`.
        /* 0 */ { before: "running sha256:oldweb sha256:oldcms; STUB_SMOKE_CODE=502" },
        // A fix-forward re-run that fails after `up` again …
        /* 1 */ { before: "commit" },
        // … and one that passes.
        /* 2 */ { before: "commit; STUB_SMOKE_CODE=200" },
      ]);
    }, SEQUENCE_BUDGET);

    it("tags :rollback once and keeps it through failed re-runs", () => {
      const [first, again] = r;
      const rollback = ["infra-web:rollback=sha256:oldweb", "infra-cms:rollback=sha256:oldcms"];
      expect(first.status).toBe(1);
      expect(first.images).toEqual(expect.arrayContaining(rollback));
      expect(first.bootstrap).toEqual(
        expect.arrayContaining(["WEB_IMAGE=sha256:oldweb", "CMS_IMAGE=sha256:oldcms"]),
      );
      expect(first.stderr).toContain("docker tag infra-web:rollback infra-web:latest");
      expect(first.stderr).toContain(
        "a re-run before the first successful deploy keeps this :rollback",
      );
      expect(again.status).toBe(1);
      expect(again.stdout).toContain(":rollback kept from ");
      expect(called(again, /^docker tag \S+ infra-(web|cms):rollback$/)).toEqual([]);
      expect(again.images).toEqual(expect.arrayContaining(rollback));
      expect(again.stderr).toContain(
        "To roll back to the images that ran before the first deploy with this script (:rollback, tagged ",
      );
      expect(again.bootstrap).toEqual(first.bootstrap);
    });

    it("drops the marker once a deploy is recorded", () => {
      const done = r[2];
      expect(done.status, done.stderr).toBe(0);
      expect(done.stdout).toContain(":rollback kept from ");
      expect(done.state.WEB_IMAGE).toBe("sha256:web3");
      expect(done.bootstrap).toEqual([]);
    });
  },
);

describe.skipIf(!RUN_SEQUENCES)(
  "deploy.sh before its first recorded deploy: a :rollback it cannot take whole stops it (B10-T2)",
  () => {
    let r: StepReport[] = [];
    const rollbackTags = (report: StepReport) =>
      called(report, /^docker tag \S+ infra-(web|cms):rollback$/);
    const builtOrStarted = (report: StepReport) => called(report, / build$| up -d/);
    beforeAll(() => {
      // The :rollback tags an older deploy.sh left (the release before the running one).
      const olderRollback =
        'echo sha256:web8 > "$T/img/infra-web__rollback"; echo sha256:cms8 > "$T/img/infra-cms__rollback"';
      r = deploys([
        // containerd store: no tag names the running web image any more; the cms image has one.
        /* 0 */ {
          before: `STUB_CONTAINERD=1; running sha256:ghostweb sha256:cms9; echo sha256:cms9 > "$T/img/infra-cms__latest"; ${olderRollback}`,
        },
        /* 1 */ { args: ["--dry-run"] },
        // The web recreated from a tagged image; the bootstrap marker cannot be written …
        /* 2 */ {
          before:
            'echo sha256:web9 > "$T/img/infra-web__latest"; running sha256:web9 sha256:cms9; STUB_BOOTSTRAP_WRITE_FAIL=1',
        },
        // … and the re-run once it can.
        /* 3 */ { before: "STUB_BOOTSTRAP_WRITE_FAIL=" },
      ]);
    }, SEQUENCE_BUDGET);

    it("refuses before the build when a running image cannot be tagged :rollback", () => {
      const run = r[0];
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "ERROR: infra-web-1 runs sha256:ghostweb, which no tag names any more: on the containerd",
      );
      expect(run.stderr).toContain("a failed deploy would have no rollback for web");
      expect(run.stderr).toContain("up -d --no-build --force-recreate web\n");
      expect(run.stderr).toContain("Nothing was built; the running containers are untouched.");
      expect(builtOrStarted(run)).toEqual([]);
      // Neither :rollback moved (never the cms's current image next to the older web one) …
      expect(rollbackTags(run)).toEqual([]);
      expect(run.images).toEqual(
        expect.arrayContaining([
          "infra-web:rollback=sha256:web8",
          "infra-cms:rollback=sha256:cms8",
        ]),
      );
      // … and no marker keeps a pair for later runs.
      expect(run.bootstrap).toEqual([]);
      expect(run.state).toEqual({});
    });

    it("says in a dry run that the deploy would stop there", () => {
      const dry = r[1];
      expect(dry.status).toBe(1);
      expect(dry.stderr).toContain("WOULD STOP: infra-web-1 runs sha256:ghostweb");
      // Neither tag is promised for an image that cannot be resolved (the real run warns too).
      expect(dry.stdout).not.toContain("would tag infra-web-1 (sha256:ghostweb)");
      expect(dry.stderr).toContain(
        "WARNING: would not be able to tag sha256:ghostweb (infra-web-1) as infra-web:pre-deploy",
      );
      expect(dry.stdout).toContain("would tag infra-cms-1 (sha256:cms9) as infra-cms:pre-deploy");
      expect(called(dry, /^docker tag |compose .* (build|up)/)).toEqual([]);
      expect(dry.bootstrap).toEqual([]);
    });

    it("stops before the build when the bootstrap marker cannot be written, and the re-run goes on", () => {
      const [unwritten, rerun] = [r[2], r[3]];
      expect(unwritten.status).toBe(1);
      expect(unwritten.stderr).toContain("mv: No space left on device");
      expect(unwritten.stderr).toMatch(
        /ERROR: could not write \S+\/infra\.bootstrap; nothing was built/,
      );
      expect(builtOrStarted(unwritten)).toEqual([]);
      expect(unwritten.bootstrap).toEqual([]);
      expect(unwritten.state).toEqual({});
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(rerun.stdout).toContain("until the first deploy is recorded");
      expect(rerun.images).toEqual(
        expect.arrayContaining([
          "infra-web:rollback=sha256:web9",
          "infra-cms:rollback=sha256:cms9",
        ]),
      );
      expect(rerun.state.WEB_IMAGE).toMatch(/^sha256:web\d+$/);
      expect(rerun.state.WEB_IMAGE).not.toBe("sha256:web9");
      expect(rerun.bootstrap).toEqual([]);
    });
  },
);

describe.skipIf(!RUN_SEQUENCES)("deploy.sh: checks, dry run and parameters (FX35)", () => {
  let r: StepReport[] = [];
  const green = JSON.stringify(
    {
      total_count: 2,
      check_runs: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ],
    },
    null,
    2,
  );
  const failed = green.replace('"skipped"', '"failure"');
  const pending = green.replace(
    '"completed",\n      "conclusion": "skipped"',
    '"in_progress",\n      "conclusion": null',
  );
  const quoted = (json: string) => `'${json.replace(/'/g, `'\\''`)}'`;
  const STAGING = {
    COMPOSE_PROJECT: "b10-5b-staging",
    SMOKE_URL: "http://localhost:8511/",
    SINNLOS_BACKUP_DIR: "/srv/b10-5b-backups",
  };
  beforeAll(() => {
    r = deploys([
      /* 0 */ { before: 'echo change >> "$REPO/infra/docker-compose.yml"', args: ["--check"] },
      /* 1 */ {},
      /* 2 */ {
        before:
          '"${G[@]}" checkout -q -- infra/docker-compose.yml; echo x > "$REPO/stray.txt"; running sha256:oldweb sha256:oldcms',
        args: ["--dry-run"],
      },
      /* 3 */ { before: "STUB_LOCK_HELD=1" },
      /* 4 */ { before: "STUB_LOCK_HELD=", args: ["--require-green-ci"] },
      /* 5 */ {},
      /* 6 */ { before: "commit", args: ["--dry-run"] },
      /* 7 */ {
        before: `"\${G[@]}" remote add origin https://github.com/example/sinnlos.git; ci ${quoted(green)}`,
        args: ["--require-green-ci"],
        env: { GITHUB_TOKEN: "ghp_testtoken123" },
      },
      /* 8 */ { before: `commit; ci ${quoted(failed)}`, args: ["--require-green-ci"] },
      /* 9 */ { before: `ci ${quoted(pending)}`, args: ["--require-green-ci"] },
      // Another project: production's smoke URL, backup dir and edge are refused …
      /* 10 */ { before: `ci ${quoted(failed)}`, env: { COMPOSE_PROJECT: "b10-5b-staging" } },
      /* 11 */ { env: { ...STAGING, DEPLOY_SEPARATE_EDGE: "0" } },
      // … and with its own of each, it deploys.
      /* 12 */ { env: { ...STAGING, DEPLOY_SEPARATE_EDGE: "1" } },
      /* 13 */ { env: { PASSWORDS_FILE: "/nonexistent/pw" }, args: ["--dry-run"] },
      // A linked worktree of the same clone deploys with the clone's state and lock.
      /* 14 */ {
        before: '"${G[@]}" worktree add -q --detach "$T/wt" HEAD; export SINNLOS_CHECKOUT="$T/wt"',
        args: ["--dry-run"],
      },
      // An untracked file where the images are built from (not only noted).
      /* 15 */ {
        before: [
          'unset SINNLOS_CHECKOUT; mkdir -p "$REPO/apps/web/src"; echo x > "$REPO/apps/web/src/page.ts"',
          '"${G[@]}" add apps/web/src/page.ts; "${G[@]}" commit -q -m web',
          'echo x > "$REPO/apps/web/src/route.ts"',
        ].join("; "),
        args: ["--dry-run"],
      },
      // An empty untracked directory: git status never lists it, and an empty
      // apps/web/app/ would replace the web's src/app in the Next.js build.
      /* 16 */ {
        before: 'rm "$REPO/apps/web/src/route.ts"; mkdir "$REPO/apps/web/app"',
        args: ["--dry-run"],
      },
      // An untracked file in packages/ (SH01: both images build
      // packages/domain from the checkout).
      /* 17 */ {
        before: [
          'rmdir "$REPO/apps/web/app"; mkdir -p "$REPO/packages/domain/src"',
          'echo x > "$REPO/packages/domain/src/stray.ts"',
        ].join("; "),
        args: ["--dry-run"],
      },
      // The example DOMAIN of infra/.env.example (5A-T1): --check refuses it.
      /* 18 */ {
        before: 'cp "$T/compose-example.json" "$T/compose.json"',
        args: ["--check"],
      },
    ]);
  }, SEQUENCE_BUDGET);

  it("keeps --check the env preflight only (no git check, no lock)", () => {
    expect(r[0].status, r[0].stderr).toBe(0);
    expect(r[0].stdout).toContain("--check: nothing deployed.");
    expect(r[0].stdout).toContain(`Traefik host: ${STUB_HOST}; smoke URL: https://${STUB_HOST}`);
    expect(r[0].stateDir).toBe(false);
  });

  it("refuses the example DOMAIN in --check, before anything is touched (5A-T1)", () => {
    const run = r[18];
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ERROR: DOMAIN in infra/.env does not fit this instance:");
    expect(run.stderr).toContain(
      "- DOMAIN=intranet.example.com is a placeholder (infra/.env.example), not this instance's host name",
    );
    expect(run.stderr).toContain("Preflight failed. Nothing was changed.");
    expect(run.stdout).not.toContain("--check: nothing deployed.");
    expect(called(run, /^curl |^docker (tag|image rm)|compose .* (build|up)/)).toEqual([]);
  });

  it("refuses a checkout with a changed tracked file before anything is touched", () => {
    const run = r[1];
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("has changed tracked files");
    expect(run.stderr).toContain("infra/docker-compose.yml");
    expect(run.stdout).not.toContain("backup kind=");
    expect(called(run, / build$| up -d/)).toEqual([]);
  });

  it("refuses untracked files or directories where the images are built from", () => {
    for (const [run, path] of [
      [r[15], "apps/web/src/route.ts"],
      [r[16], "apps/web/app/"],
      [r[17], "packages/"],
    ] as const) {
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "has untracked files or directories where the web and cms images are",
      );
      expect(run.stderr.split("\n")).toContain(`         ${path}`);
      // Elsewhere an untracked file is only a note (stray.txt, step 2).
      expect(run.stderr).not.toContain("stray.txt");
      expect(called(run, / build$| up -d/)).toEqual([]);
    }
  });

  it("changes nothing with --dry-run, notes untracked files and plans the :rollback fallback", () => {
    const run = r[2];
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("NOTE: untracked files in the checkout");
    expect(run.stdout).toContain("stray.txt");
    expect(run.stdout).toContain("would tag infra-web-1 (sha256:oldweb) as infra-web:rollback");
    expect(run.stdout).toContain("Dry run complete: nothing was changed.");
    expect(run.stdout).not.toContain("backup kind=");
    expect(called(run, /^docker (tag|image rm)|compose .* (build|up)/)).toEqual([]);
    // The lock of step 1 left the state dir; the dry run added nothing to it.
    expect(run.state).toEqual({});
    expect(run.bootstrap).toEqual([]);
    expect(run.images).toEqual([]);
  });

  it("refuses while another deploy holds the lock", () => {
    expect(r[3].status).toBe(1);
    expect(r[3].stderr).toContain("another infra/deploy.sh is running for compose project infra");
    expect(r[3].stdout).not.toContain("backup kind=");
  });

  it("refuses unknown CI with --require-green-ci, and only warns without it", () => {
    expect(r[4].status).toBe(1);
    expect(r[4].stderr).toContain(
      "ERROR: --require-green-ci, and CI is unknown: the origin remote is not on github.com",
    );
    expect(r[4].stdout).not.toContain("backup kind=");
    const run = r[5];
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("WARNING: CI is unknown");
    // No state yet, containers ran: the fallback tags them :rollback.
    expect(run.stdout).toContain("infra-web-1 (sha256:oldweb) -> infra-web:rollback");
    expect(run.images).toEqual(
      expect.arrayContaining([
        "infra-web:rollback=sha256:oldweb",
        "infra-cms:rollback=sha256:oldcms",
      ]),
    );
    expect(run.state.WEB_IMAGE).toBe("sha256:web1");
    // Recorded: the :rollback bootstrap marker is gone.
    expect(run.bootstrap).toEqual([]);
  });

  it("shares the state and the lock with the linked worktrees of the clone", () => {
    const run = r[14];
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`-> the last-known-good deploy ${tagOf(r[7])}`);
    expect(run.stdout).toMatch(/record \S*\/checkout\/\.git\/sinnlos-deploy\/infra\.state$/m);
    expect(run.stdout).not.toContain("/worktrees/");
  });

  it("plans no record when live-smoke would lack the demo credentials", () => {
    const run = r[13];
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("5. NOT recorded: live-smoke would not run");
    expect(run.stdout).not.toContain("5. tag ");
  });

  it("plans a dry run from the state, and changes nothing", () => {
    const [good, dry] = [r[5], r[6]];
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`-> the last-known-good deploy ${tagOf(good)}`);
    expect(dry.stdout).toMatch(/5\. tag infra-\{web,cms\}:[0-9a-f]{12} \(commit [0-9a-f]{40}\)/);
    expect(called(dry, /^docker (tag|image rm)|compose .* (build|up)/)).toEqual([]);
    expect(dry.state).toEqual(good.state);
    expect(dry.images.sort()).toEqual(good.images.sort());
  });

  it("reads the GitHub check runs of HEAD, with the token on curl's stdin only", () => {
    const run = r[7];
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("CI: 2 CI check(s) passed");
    const apiCall = run.calls.find((c) => c.includes("api.github.com"));
    expect(apiCall).toContain(`/repos/example/sinnlos/commits/${run.state.SHA}/check-runs`);
    expect(apiCall).not.toContain("ghp_testtoken123");
    expect(run.curlStdin).toContain('header = "Authorization: Bearer ghp_testtoken123"');
  });

  it("refuses failed or running CI with --require-green-ci, and deploys with a warning without it", () => {
    expect(r[8].status).toBe(1);
    expect(r[8].stderr).toContain("CI is failed: CI did not pass");
    expect(r[9].status).toBe(1);
    expect(r[9].stderr).toContain("CI is pending: CI is still running");
    expect(r[12].status, r[12].stderr).toBe(0);
    expect(r[12].stderr).toContain("WARNING: CI is failed");
  });

  it("refuses another compose project with production's smoke URL, backup dir or edge", () => {
    const [bare, sharedEdge] = [r[10], r[11]];
    for (const run of [bare, sharedEdge]) {
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "ERROR: compose project b10-5b-staging is not isolated from production:",
      );
      expect(run.stderr).toContain("containers of compose project infra exist on this Docker host");
      expect(run.stdout).not.toContain("backup kind=");
      expect(called(run, / build$| up -d/)).toEqual([]);
    }
    expect(bare.stderr).toContain(
      `- SMOKE_URL is not set: the smoke checks would test https://${STUB_HOST}.`,
    );
    expect(bare.stderr).toContain("- SINNLOS_BACKUP_DIR is not set");
    expect(sharedEdge.stderr).not.toContain("SMOKE_URL is not set");
    expect(sharedEdge.stderr).not.toContain("SINNLOS_BACKUP_DIR is not set");
    expect(
      called(sharedEdge, /^docker ps -aq --filter label=com.docker.compose.project=infra$/),
    ).toHaveLength(1);
  });

  it("takes the compose project and the smoke URL as parameters", () => {
    const run = r[12];
    expect(run.status, run.stderr).toBe(0);
    // Its own backup dir, and a quick-access .env copy of its own (absent: never refreshed).
    expect(run.stdout).toMatch(
      /backup kind=predeploy db=b10-5b-staging-db-1 dir=\/srv\/b10-5b-backups quick=\S+\/\.git\/sinnlos-deploy\/b10-5b-staging\.quick-access\.env/,
    );
    expect(run.stdout).toContain("live-smoke base=http://localhost:8511 cms=b10-5b-staging-cms-1");
    expect(run.calls.some((c) => c.startsWith("docker compose -p b10-5b-staging "))).toBe(true);
    expect(
      run.calls.some((c) => c.startsWith("curl ") && c.includes("http://localhost:8511/")),
    ).toBe(true);
    // Its own state file; the infra state is untouched.
    expect(run.state).toEqual(r[9].state);
    // Project infra keeps production's backup dir and quick-access copy (the defaults).
    expect(r[7].stdout).toContain("backup kind=predeploy db=infra-db-1 dir=default quick=default");
    expect(run.state.TAG).toBe(tagOf(r[7]));
  });
});

describe("deploy.sh: parameters and state handling, statically (FX35)", () => {
  it("keeps today's defaults", () => {
    const lines = DEPLOY.split("\n");
    for (const line of [
      'PROJECT="${COMPOSE_PROJECT:-infra}"',
      'SMOKE_URL="${SMOKE_URL:-}"',
      'SMOKE_URL="${SMOKE_URL:-https://${TRAEFIK_HOST}}"',
      'PASSWORDS_FILE="${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}"',
      'CHECKOUT="$(cd "${SINNLOS_CHECKOUT:-${SCRIPT_DIR}/..}" && pwd)"',
      'KEEP_TAGS="${DEPLOY_KEEP_TAGS:-5}"',
    ]) {
      expect(lines, line).toContain(line);
    }
  });

  it("never sources the state file", () => {
    expect(DEPLOY).not.toMatch(/(^|\s)(source|\.)\s+"?\$\{?STATE_FILE/m);
  });

  it("runs the git checks with a command-line safe.directory, never changing git config", () => {
    expect(DEPLOY).toContain('GIT=(git -c "safe.directory=${CHECKOUT}" -C "${CHECKOUT}")');
    expect(DEPLOY).not.toMatch(/git [^\n]*config --(global|system|local|add)/);
  });
});
