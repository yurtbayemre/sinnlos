/**
 * infra/live-smoke.sh (IN06, DOC-SMOKE-PW-ARGV). The end-to-end run needs a
 * real stack (lane rehearsal, docs/DEPLOYMENT.md §6.1); pinned here:
 *   1. no password ever lands on a command line: curl reads SMOKE_PASSWORD
 *      from stdin, the cms container gets SMOKE_AUTHOR_PASSWORD through
 *      `docker exec -e`, and the node program reads the environment;
 *   2. the target announcement is found with GETs only;
 *   3. the stream is fetched with --compressed and must come back as
 *      text/event-stream without a Content-Encoding;
 *   4. the notification cleanup removes only this run's comment
 *      notifications of the smoke author;
 *   5. an Entra-only web (ENTRA_ENABLED=1 without AUTH_LOCAL_ENABLED=1)
 *      ends after the datetime check with a SKIPPED note and exit 0 (run in
 *      bash with docker stubbed).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new URL("./live-smoke.sh", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;

/** The node program the script runs in the cms container. */
const PROBE = SCRIPT.slice(
  SCRIPT.indexOf("CMS_PROBE=\"$(cat <<'NODE'"),
  SCRIPT.indexOf("\nNODE\n", SCRIPT.indexOf("CMS_PROBE=")),
);

describe("live-smoke.sh: passwords stay off the command line", () => {
  const lines = SCRIPT.split("\n");

  it("never hands a password to a command as an argument", () => {
    const uses = lines.filter((line) => /SMOKE_(AUTHOR_)?PASSWORD/.test(line));
    for (const line of uses) {
      const allowed =
        /^\s*(if \[\[ -z|SMOKE_(AUTHOR_)?PASSWORD="\$\(lookup_password|fail "missing passwords|#)/.test(
          line,
        ) ||
        /^\s*if \[\[ -z "\$\{SMOKE_PASSWORD\}" \|\| -z "\$\{SMOKE_AUTHOR_PASSWORD\}" \]\]; then$/.test(
          line,
        ) ||
        line.includes(`printf '%s' "\${SMOKE_PASSWORD}" |`) ||
        line.includes('SMOKE_AUTHOR_PASSWORD="${SMOKE_AUTHOR_PASSWORD}"') ||
        line.includes("-e SMOKE_AUTHOR_PASSWORD") ||
        line.includes("SMOKE_AUTHOR_PASSWORD: password") ||
        /^#/.test(line.trim());
      expect(allowed, line).toBe(true);
    }
    expect(SCRIPT).not.toMatch(/--data-urlencode "password=/);
    expect(SCRIPT).toContain('--data-urlencode "password@-"');
    expect(SCRIPT).not.toContain("process.argv");
  });

  it("gives the cms container the author's password through its environment", () => {
    expect(SCRIPT).toMatch(
      /docker exec -i -e MODE -e TARGET -e STREAM_USER_ID -e SMOKE_AUTHOR_EMAIL -e SMOKE_AUTHOR_PASSWORD \\\n\s+"\$\{CMS_CONTAINER\}" node --input-type=module -/,
    );
    expect(PROBE).toContain("SMOKE_AUTHOR_PASSWORD: password");
  });
});

describe("live-smoke.sh: what it touches", () => {
  it("finds the target announcement with GETs only", () => {
    const discover = PROBE.slice(
      PROBE.indexOf('if (MODE === "discover")'),
      PROBE.indexOf('} else if (MODE === "comment")'),
    );
    expect(discover).toContain("/api/announcements?");
    expect(discover).toContain("filters[author][id][$eq]=");
    expect(discover).not.toMatch(/method:/);
    // One comment per run, after the subscription.
    expect(SCRIPT.indexOf("cms_probe comment")).toBeGreaterThan(SCRIPT.indexOf("/live/subscribe"));
    expect(SCRIPT.match(/cms_probe comment/g)).toHaveLength(1);
  });

  it("fetches the stream compressed and refuses a Content-Encoding on it", () => {
    expect(SCRIPT).toMatch(/curl -sS -N --compressed -D "\$\{STREAM_HEADERS\}"/);
    expect(SCRIPT).toContain("grep -qi '^content-type: *text/event-stream'");
    expect(SCRIPT).toContain("if grep -qi '^content-encoding:' \"${HEADERS}\"; then");
  });

  it("removes only this run's comment notifications of the smoke author", () => {
    const sql = SCRIPT.slice(
      SCRIPT.indexOf("WITH doomed AS ("),
      SCRIPT.indexOf("SELECT count(*) FROM removed;"),
    );
    expect(sql).toContain("lower(u.email) = lower(:'author') AND n.type = 'comment'");
    expect(sql).toContain("n.link = '/announcements' AND n.created_at >= :'since'::timestamptz");
    // The run's start is read right before the comment, from the database's clock.
    const started = SCRIPT.indexOf("RUN_STARTED=\"$(db_psql -c 'SELECT clock_timestamp()'");
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(SCRIPT.indexOf("cms_probe comment ||"));
  });
});

describe.skipIf(!HAS_BASH)("live-smoke.sh: an Entra-only instance", { timeout: 30_000 }, () => {
  /** Runs the script with docker stubbed: the web container's env holds `webEnv`. */
  function run(webEnv: string[]): { status: number | null; stdout: string; stderr: string } {
    const script = [
      "docker() {",
      '  case "$1" in',
      "    exec) cat > /dev/null ;;", // no naive columns
      "    logs) echo '[datetime] process time zone UTC, APP_TIME_ZONE Europe/Berlin' ;;",
      `    inspect) printf '%s\\n' PATH=/usr/bin ${webEnv.map((e) => `'${e}'`).join(" ")} ;;`,
      "    *) return 1 ;;",
      "  esac",
      "}",
      "curl() { echo curl-called >&2; return 7; }",
      "export -f docker curl",
      "export PASSWORDS_FILE=/nonexistent/passwords.txt",
      "unset SMOKE_PASSWORD SMOKE_AUTHOR_PASSWORD",
      "cat > \"${TMPDIR:-/tmp}/live-smoke-$$.sh\" <<'LIVE_SMOKE_EOF'",
      SCRIPT.trimEnd(),
      "LIVE_SMOKE_EOF",
      'bash "${TMPDIR:-/tmp}/live-smoke-$$.sh"; rc=$?',
      'rm -f "${TMPDIR:-/tmp}/live-smoke-$$.sh"',
      "exit $rc",
      "",
    ].join("\n");
    const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it("checks the datetime contract, then skips the sign-in steps with exit 0", () => {
    const res = run(["ENTRA_ENABLED=1", "AUTH_LOCAL_ENABLED=0"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("live-smoke: datetime contract OK");
    expect(res.stdout).toContain("live-smoke: SKIPPED the sign-in steps: Entra-only instance");
    expect(res.stderr).not.toContain("curl-called");
  });

  it("signs in as usual when local sign-in is on next to Entra, or Entra is off", () => {
    for (const env of [["ENTRA_ENABLED=1", "AUTH_LOCAL_ENABLED=1"], ["ENTRA_ENABLED=0"], []]) {
      const res = run(env);
      expect(res.stdout, env.join(" ")).not.toContain("SKIPPED");
      // Without credentials it stops at the password check, before any request.
      expect(res.status, env.join(" ")).toBe(1);
      expect(res.stderr, env.join(" ")).toContain("live-smoke: FAIL — missing passwords");
    }
  });
});
