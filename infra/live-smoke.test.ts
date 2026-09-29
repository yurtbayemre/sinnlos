/**
 * infra/live-smoke.sh (IN06, DOC-SMOKE-PW-ARGV). The end-to-end run needs a
 * real stack (lane rehearsal, docs/DEPLOYMENT.md §6.1); pinned here:
 *   1. no password ever lands on a command line: curl reads SMOKE_PASSWORD
 *      from stdin, the cms container gets SMOKE_AUTHOR_PASSWORD through
 *      `docker exec -e`, and the node program reads the environment; the
 *      author signs in once per run, and the comment and the cleanup get
 *      that JWT through `docker exec -e` as well;
 *   2. the target announcement is found with GETs only;
 *   3. the stream is fetched with --compressed and must come back as
 *      text/event-stream without a Content-Encoding;
 *   4. the notification cleanup removes only this run's comment
 *      notifications of the smoke author;
 *   5. an Entra-only web (ENTRA_ENABLED=1 without AUTH_LOCAL_ENABLED=1)
 *      ends after the datetime check with a SKIPPED note and exit 0 (run in
 *      bash with docker stubbed);
 *   6. the stream user defaults to an announcement author from the
 *      credentials file (alex.morgan, else casey.jones), so the
 *      notification frame path is checked by default, and an unchecked
 *      path prints the WARNING line deploy.sh looks for;
 *   7. without BASE_URL the public origin is https://<DOMAIN>, DOMAIN from
 *      the environment or else from the .env next to the script, never the
 *      owner's host name (5A-T1);
 *   8. the cms process zone comes from its boot line, and once that line has
 *      rotated out of `docker logs`, from node in the running cms container;
 *      either must be UTC (B10-T1).
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
      /docker exec -i -e MODE -e TARGET -e STREAM_USER_ID -e SMOKE_JWT -e SMOKE_AUTHOR_EMAIL -e SMOKE_AUTHOR_PASSWORD \\\n\s+"\$\{CMS_CONTAINER\}" node --input-type=module -/,
    );
    expect(PROBE).toContain("SMOKE_AUTHOR_PASSWORD: password");
  });

  it("signs the author in once per run and hands the JWT on through the environment only", () => {
    // One sign-in in the probe, skipped when SMOKE_JWT carries an earlier one.
    expect(PROBE.match(/\/api\/auth\/local/g)).toHaveLength(1);
    expect(PROBE).toContain("let jwt = SMOKE_JWT;\nif (!jwt) {");
    // A throttled sign-in says how long to wait.
    expect(PROBE).toContain("wait 60 s before a re-run");
    // discover prints it; the shell takes it out before anything prints DISCOVERED.
    expect(PROBE).toContain("console.log(`JWT=${jwt}`);");
    const discovered = SCRIPT.indexOf('DISCOVERED="$(cms_probe discover)"');
    const stripped = SCRIPT.indexOf(
      `DISCOVERED="$(printf '%s\\n' "\${DISCOVERED}" | grep -v '^JWT=' || true)"`,
    );
    expect(discovered).toBeGreaterThan(-1);
    expect(stripped).toBeGreaterThan(discovered);
    // Nothing between the two prints DISCOVERED (with the JWT still in it).
    expect(SCRIPT.slice(discovered, stripped)).not.toMatch(
      /\becho\b|fail "[^"\n]*\$\{DISCOVERED\}/,
    );
    // Every other use of the variable: the environment of `docker exec`, or comments.
    for (const line of SCRIPT.split("\n").filter((l) => l.includes("SMOKE_JWT"))) {
      const allowed =
        /^\s*#/.test(line) ||
        line.includes('SMOKE_JWT="${SMOKE_JWT:-}"') ||
        line.includes("-e SMOKE_JWT") ||
        line.startsWith(`SMOKE_JWT="$(printf '%s\\n' "\${DISCOVERED}" | sed -n 's/^JWT=//p')"`) ||
        line.includes("SMOKE_JWT, STREAM_USER_ID, TARGET } = process.env;") ||
        line.includes("let jwt = SMOKE_JWT;");
      expect(allowed, line).toBe(true);
    }
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

  it("requires the stream to say emitFresh (the cms keepalive reaches the web) before the comment (LF05)", () => {
    expect(SCRIPT).toContain('FRESH_SECONDS="${FRESH_SECONDS:-35}"');
    const check = SCRIPT.indexOf(`if grep -q '"emitFresh":true' "\${STREAM_LOG}"; then`);
    expect(check).toBeGreaterThan(SCRIPT.indexOf('echo "live-smoke: stream open'));
    // Before the comment: its own emit would make the leg fresh too.
    expect(check).toBeLessThan(SCRIPT.indexOf("cms_probe comment ||"));
    expect(SCRIPT).toContain('fail "the cms leg is not fresh: no');
  });

  it("subscribes with the full channel set at revision 1 and checks that the set was applied (LF05)", () => {
    expect(SCRIPT).toContain(
      '--data "{\\"connId\\":\\"${CONN_ID}\\",\\"rev\\":1,\\"channels\\":[\\"announcement:${TARGET_DOC_ID}\\"]}"',
    );
    expect(SCRIPT).not.toContain('\\"add\\"');
    expect(SCRIPT).toContain(`grep -q '"applied":true' "\${WORKDIR}/subscribe.json"`);
  });

  it("fetches the stream compressed and refuses a Content-Encoding on it", () => {
    expect(SCRIPT).toMatch(/curl -sS -N --compressed -D "\$\{STREAM_HEADERS\}"/);
    expect(SCRIPT).toContain("grep -qi '^content-type: *text/event-stream'");
    expect(SCRIPT).toContain("if grep -qi '^content-encoding:' \"${HEADERS}\"; then");
    // The failure names the edge fix.
    expect(SCRIPT).toContain(
      "/live/ needs a router without the sinnlos-compress middleware (sinnlos-live in infra/docker-compose.traefik.yml",
    );
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

/**
 * Runs the script with docker stubbed: the web container's env holds
 * `webEnv`; curl fails at once (no request gets through). `setup` runs
 * before the script, after the defaults (no credentials file, no
 * passwords, no BASE_URL, DOMAIN=intranet.acme.test; the script lives in
 * $W, so $W/.env is the .env next to it). `docker logs` prints
 * STUB_BOOT_LINE (by default the cms boot line in UTC; set it empty for a
 * log without one); `docker exec <cms> node -e …` prints STUB_NODE_ZONE
 * (UTC) and exits with STUB_NODE_RC (0), and says "exec-node-called" on
 * stderr.
 */
function run(
  webEnv: string[],
  setup = "",
): { status: number | null; stdout: string; stderr: string } {
  const script = [
    "docker() {",
    '  case "$1" in',
    "    exec)",
    // The zone probe in the cms container (not cms_probe's `node --input-type=module -`).
    '      if [[ "$*" == *" node -e "* ]]; then',
    '        echo exec-node-called >&2; printf "%s" "${STUB_NODE_ZONE:-UTC}"; return "${STUB_NODE_RC:-0}"',
    "      fi",
    "      cat > /dev/null ;;", // no naive columns
    '    logs) printf "%s\n" "${STUB_BOOT_LINE-[datetime] process time zone UTC, APP_TIME_ZONE Europe/Berlin}" ;;',
    `    inspect) printf '%s\n' PATH=/usr/bin ${webEnv.map((e) => `'${e}'`).join(" ")} ;;`,
    "    *) return 1 ;;",
    "  esac",
    "}",
    "curl() { echo curl-called >&2; return 7; }",
    "export -f docker curl",
    "export PASSWORDS_FILE=/nonexistent/passwords.txt",
    "unset SMOKE_EMAIL SMOKE_PASSWORD SMOKE_AUTHOR_PASSWORD BASE_URL",
    "export DOMAIN=intranet.acme.test",
    'W="$(mktemp -d)"',
    setup,
    "cat > \"$W/live-smoke.sh\" <<'LIVE_SMOKE_EOF'",
    SCRIPT.trimEnd(),
    "LIVE_SMOKE_EOF",
    'bash "$W/live-smoke.sh"; rc=$?',
    'rm -rf "$W"',
    "exit $rc",
    "",
  ].join("\n");
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe.skipIf(!HAS_BASH)("live-smoke.sh: an Entra-only instance", { timeout: 30_000 }, () => {
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

describe.skipIf(!HAS_BASH)(
  "live-smoke.sh: the cms zone once its boot line has rotated out (B10-T1)",
  { timeout: 30_000 },
  () => {
    // Entra-only, so a passing datetime check ends the run with exit 0.
    const ENTRA_ONLY = ["ENTRA_ENABLED=1"];
    const NO_BOOT_LINE = "export STUB_BOOT_LINE=";

    it("reads the boot line while it is there, without asking the container", () => {
      const res = run(ENTRA_ONLY);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain(
        "live-smoke: datetime contract OK (process time zone UTC, APP_TIME_ZONE Europe/Berlin), from the cms boot line",
      );
      expect(res.stderr).not.toContain("exec-node-called");
      const berlin = run(
        ENTRA_ONLY,
        "export STUB_BOOT_LINE='[datetime] process time zone Europe/Berlin, APP_TIME_ZONE Europe/Berlin'",
      );
      expect(berlin.status).toBe(1);
      expect(berlin.stderr).toContain(
        "live-smoke: FAIL — the cms does not report the process zone UTC: [datetime] process time zone Europe/Berlin",
      );
      expect(berlin.stderr).not.toContain("exec-node-called");
    });

    it("asks node in the running cms container without a boot line, and passes on UTC", () => {
      for (const zone of ["UTC", "Etc/UTC"]) {
        const res = run(ENTRA_ONLY, `${NO_BOOT_LINE}\nexport STUB_NODE_ZONE=${zone}`);
        expect(res.status, res.stderr).toBe(0);
        expect(res.stderr).toContain("exec-node-called");
        expect(res.stdout).toContain(
          `live-smoke: datetime contract OK (process time zone ${zone}), from the running cms container: its boot line has rotated out of docker logs infra-cms-1`,
        );
        expect(res.stdout).toContain("live-smoke: SKIPPED the sign-in steps");
      }
    });

    it("fails when the running cms container is in another zone, or node does not answer", () => {
      const berlin = run(ENTRA_ONLY, `${NO_BOOT_LINE}\nexport STUB_NODE_ZONE=Europe/Berlin`);
      expect(berlin.status).toBe(1);
      expect(berlin.stderr).toContain(
        "live-smoke: FAIL — the cms process runs in Europe/Berlin, not UTC (asked node in infra-cms-1",
      );
      expect(berlin.stdout).not.toContain("datetime contract OK");
      expect(berlin.stdout).not.toContain("SKIPPED");
      const down = run(ENTRA_ONLY, `${NO_BOOT_LINE}\nexport STUB_NODE_RC=1`);
      expect(down.status).toBe(1);
      expect(down.stderr).toContain(
        "live-smoke: FAIL — no [datetime] boot line in docker logs infra-cms-1, and node in that container did not answer",
      );
    });
  },
);

describe.skipIf(!HAS_BASH)(
  "live-smoke.sh: the stream user checks the notification frame by default",
  { timeout: 30_000 },
  () => {
    /** The stream user the script picks, given credential-file lines and extra setup. */
    function streamUser(lines: string[], setup = ""): string {
      const res = run(
        [],
        [
          `printf '%s\n' ${lines.map((l) => `'${l}'`).join(" ")} > "$W/pw"`,
          'export PASSWORDS_FILE="$W/pw"',
          setup,
        ].join("\n"),
      );
      // It gets as far as the first request (curl is stubbed to fail).
      expect(res.stderr).toContain("curl-called");
      return /^live-smoke: stream user (\S+), comment author (\S+)$/m.exec(res.stdout)?.[1] ?? "";
    }
    const AUTHOR = "sam.chen@sinnlos.local\tpw-sam";

    it("prefers alex.morgan, who authors seeded announcements", () => {
      expect(
        streamUser([
          "# demo accounts",
          "casey.jones@sinnlos.local\tpw-casey",
          "alex.morgan@sinnlos.local\tpw-alex",
          AUTHOR,
        ]),
      ).toBe("alex.morgan@sinnlos.local");
    });

    it("keeps casey.jones for a credentials file without alex.morgan", () => {
      expect(streamUser(["casey.jones@sinnlos.local\tpw-casey", AUTHOR])).toBe(
        "casey.jones@sinnlos.local",
      );
    });

    it("takes SMOKE_EMAIL as given, and casey.jones for a bare SMOKE_PASSWORD", () => {
      const lines = [
        "alex.morgan@sinnlos.local\tpw-alex",
        "riley.kim@sinnlos.local\tpw-riley",
        AUTHOR,
      ];
      expect(streamUser(lines, "export SMOKE_EMAIL=riley.kim@sinnlos.local")).toBe(
        "riley.kim@sinnlos.local",
      );
      expect(streamUser(lines, "export SMOKE_PASSWORD=pw-casey")).toBe("casey.jones@sinnlos.local");
    });

    it("warns, in the words deploy.sh looks for, when the frame path went unchecked", () => {
      const deploy = readFileSync(new URL("./deploy.sh", import.meta.url), "utf8");
      const phrase = "the notification frame path was not checked";
      expect(SCRIPT).toContain(`echo "live-smoke: WARNING — ${phrase}: `);
      expect(deploy).toContain(`grep -q '${phrase}' "\${LIVE_SMOKE_OUT}"`);
    });
  },
);

describe.skipIf(!HAS_BASH)(
  "live-smoke.sh: the public origin follows DOMAIN (5A-T1)",
  { timeout: 30_000 },
  () => {
    const CREDENTIALS = [
      "printf '%s\\t%s\\n' alex.morgan@sinnlos.local pw-alex sam.chen@sinnlos.local pw-sam > \"$W/pw\"",
      'export PASSWORDS_FILE="$W/pw"',
    ].join("\n");
    /** The run with credentials and `setup`: its exit code, origin line and failure. */
    function origin(setup: string) {
      const res = run([], `${CREDENTIALS}\n${setup}`);
      return {
        status: res.status,
        origin: /^live-smoke: public origin (\S+)$/m.exec(res.stdout)?.[1] ?? "",
        stderr: res.stderr,
      };
    }

    it("takes BASE_URL as given", () => {
      expect(origin("export BASE_URL=https://staging.acme.test/").origin).toBe(
        "https://staging.acme.test",
      );
    });

    it("builds it from DOMAIN in the environment", () => {
      const res = origin("");
      expect(res.origin).toBe("https://intranet.acme.test");
      // It then gets as far as the first request (curl is stubbed to fail).
      expect(res.stderr).toContain("curl-called");
    });

    it("reads DOMAIN from the .env next to the script: the last line, quotes and comment removed", () => {
      const env = (lines: string[]) =>
        ["unset DOMAIN", "cat > \"$W/.env\" <<'ENV_EOF'", ...lines, "ENV_EOF"].join("\n");
      expect(
        origin(
          env([
            "# DOMAIN=commented.acme.test",
            "DOMAIN=old.acme.test",
            'DOMAIN="intranet.acme.test"',
          ]),
        ).origin,
      ).toBe("https://intranet.acme.test");
      expect(origin(env(["DOMAIN=intranet.acme.test   # the public host"])).origin).toBe(
        "https://intranet.acme.test",
      );
      expect(origin(env(["export DOMAIN='intranet.acme.test'"])).origin).toBe(
        "https://intranet.acme.test",
      );
    });

    it("fails before any request without BASE_URL and DOMAIN, or with a DOMAIN that is no bare host", () => {
      const none = origin("unset DOMAIN");
      expect(none.status).toBe(1);
      expect(none.stderr).toContain(
        "live-smoke: FAIL — BASE_URL is not set, and neither the environment nor",
      );
      expect(none.stderr).not.toContain("curl-called");
      const scheme = origin("export DOMAIN=https://intranet.acme.test");
      expect(scheme.status).toBe(1);
      expect(scheme.stderr).toContain(
        "DOMAIN=https://intranet.acme.test is not a bare host name (no scheme, port or path)",
      );
      expect(scheme.stderr).not.toContain("curl-called");
    });
  },
);
