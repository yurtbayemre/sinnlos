import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digestsEnabled } from "../digest/send-digests";
import {
  GUARDED_SECRET_KEYS,
  PLACEHOLDER_MARKERS,
  WARN_ONLY_SECRET_KEYS,
  findPlaceholderSecrets,
} from "./env-guard";

/**
 * infra/deploy.sh re-implements the cms boot guards in awk, so a bad
 * infra/.env fails BEFORE `up -d --build` replaces the running containers
 * (FX13). Nothing tied the two together (final review C7-PREFLIGHT-ENVGUARD-
 * DRIFT): a key added to GUARDED_SECRET_KEYS, or a marker to
 * PLACEHOLDER_MARKERS, would pass the preflight and then stop the new cms
 * from booting. Pinned here:
 *   1. the key lists and markers equal env-guard.ts (static),
 *   2. the preflight awk gives the same verdict as findPlaceholderSecrets
 *      and digestsEnabled for a table of values (runs the real awk program
 *      where an `awk` binary exists: CI, Git Bash; skipped otherwise),
 *   3. the D-SESSION-01 JWT rotation gate (final review C3) reads the label
 *      apps/web/Dockerfile sets, and its env extraction undoes Go's JSON
 *      escaping, so equal secrets compare equal,
 *   4. the Microsoft sign-in gate (Strapi 5.51+ rejects the web's token
 *      exchange) fires exactly when the web would offer Microsoft sign-in
 *      with a real (GUID) client id, and is fatal,
 *   5. the rollback hint of a failed deploy tells a cms image that still
 *      starts with pnpm by its Cmd and prints a working direct start (runs
 *      the real function with docker stubbed where `bash` exists),
 *   6. for a :rollback cms from before poll guest access it prints, before
 *      the retag, how to stop the cms and remove the guest vote permission
 *      (infra/rollback/revoke-guest-poll-vote.sql), and nothing otherwise.
 *
 * Lives with the cms tests because it imports cms code
 * (tsconfig.test.json: no infra test imports cms code).
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) =>
  readFileSync(join(REPO_ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const DEPLOY = read("infra", "deploy.sh");
const WEB_DOCKERFILE = read("apps", "web", "Dockerfile");
const WEB_AUTH_CONFIG = read("apps", "web", "src", "lib", "auth-config.ts");
const COMPOSE = read("infra", "docker-compose.yml");

/** `NAME="value"` at the start of a deploy.sh line. */
function shellAssignment(name: string): string {
  const line = DEPLOY.split("\n").find((l) => l.startsWith(`${name}="`));
  if (!line) throw new Error(`${name} not found in infra/deploy.sh`);
  return line.slice(name.length + 2, line.lastIndexOf('"'));
}

/** The single-quoted awk program that follows `head` in deploy.sh. */
function awkProgram(head: string): string {
  const start = DEPLOY.indexOf(head);
  if (start < 0) throw new Error(`awk program after ${head} not found in infra/deploy.sh`);
  const from = start + head.length;
  return DEPLOY.slice(from, DEPLOY.indexOf("'", from));
}

const PREFLIGHT_AWK = awkProgram(
  'awk -v fatal_keys="${PREFLIGHT_FATAL_KEYS}" -v warn_keys="${PREFLIGHT_WARN_KEYS}" ' + "'",
);
const ENV_VALUE_AWK = awkProgram("awk -v want=" + '"$1" ' + "'");

const words = (value: string) => value.split(" ").filter(Boolean);
const sorted = (values: readonly string[]) => [...values].sort();

const HAS_AWK = spawnSync("awk", ["BEGIN { exit 0 }"]).status === 0;

const awkDir = HAS_AWK ? mkdtempSync(join(tmpdir(), "deploy-preflight-")) : "";
afterAll(() => {
  if (awkDir) rmSync(awkDir, { recursive: true, force: true });
});
const programFiles = new Map<string, string>();

/**
 * Runs an awk program from a file (`-f`), as bash hands it over verbatim:
 * on Windows a program passed on the command line is re-parsed by the MSYS
 * runtime, which mangles its backslashes.
 */
function runAwk(program: string, vars: Record<string, string>, input: string): string[] {
  let file = programFiles.get(program);
  if (!file) {
    file = join(awkDir, `program-${programFiles.size}.awk`);
    writeFileSync(file, program);
    programFiles.set(program, file);
  }
  const args = Object.entries(vars).flatMap(([key, value]) => ["-v", `${key}=${value}`]);
  const out = execFileSync("awk", [...args, "-f", file], { input, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

const BACKSLASH = String.fromCharCode(92);
/**
 * `docker compose config --format json` as Go's encoding/json writes it:
 * indented, one environment entry per line, and <, > and & escaped as
 * backslash-u00XX sequences.
 */
function composeJson(environment: Record<string, string | null>): string {
  const json = JSON.stringify({ services: { cms: { environment } } }, null, 2);
  return json.replace(
    /[<>&]/g,
    (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

describe("deploy.sh preflight mirrors env-guard.ts (C7)", () => {
  it("fails on exactly the guarded cms secrets plus the web's AUTH_SECRET", () => {
    const fatal = words(shellAssignment("PREFLIGHT_FATAL_KEYS"));
    expect(new Set(fatal).size).toBe(fatal.length);
    expect(sorted(fatal)).toEqual(sorted([...GUARDED_SECRET_KEYS, "AUTH_SECRET"]));
  });

  it("only warns on the warn-only keys", () => {
    expect(sorted(words(shellAssignment("PREFLIGHT_WARN_KEYS")))).toEqual(
      sorted(WARN_ONLY_SECRET_KEYS),
    );
  });

  it("uses the same placeholder markers and the <...> stand-in rule", () => {
    const lines = PREFLIGHT_AWK.split("\n").map((l) => l.trim());
    expect(lines).toContain("if (p ~ /^<.*>$/) return 1");
    const markerLine = lines.find((l) => l.startsWith("if (p ~ /") && !l.includes("^<"));
    expect(markerLine).toBeDefined();
    const regex = markerLine!.slice(markerLine!.indexOf("/") + 1, markerLine!.lastIndexOf("/"));
    const markers = regex.split("|");
    expect(sorted(markers)).toEqual(sorted(PLACEHOLDER_MARKERS));
    // Plain lowercase fragments only: awk matches them as regexes against the
    // lowercased value, env-guard.ts with includes() — equal only for these.
    for (const marker of PLACEHOLDER_MARKERS) expect(marker).toMatch(/^[a-z0-9-]+$/);
  });

  const SAMPLES = [
    "",
    "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==",
    "change-me-now",
    "CHANGEME",
    "toBeModified1",
    "generate-with-openssl-rand",
    "Some-Placeholder-Value",
    "<secret>",
    " <openssl rand -base64 32> ",
    "real1, change-me",
    "real1,real2",
    "abc<def>",
    "a&b<c",
    ",,",
  ];

  it.skipIf(!HAS_AWK)("gives the same placeholder verdict as findPlaceholderSecrets", () => {
    const keys = [...GUARDED_SECRET_KEYS, ...WARN_ONLY_SECRET_KEYS];
    for (const value of SAMPLES) {
      const env = Object.fromEntries(keys.map((key) => [key, value]));
      const findings = runAwk(
        PREFLIGHT_AWK,
        {
          fatal_keys: shellAssignment("PREFLIGHT_FATAL_KEYS"),
          warn_keys: shellAssignment("PREFLIGHT_WARN_KEYS"),
        },
        composeJson(env),
      );
      const verdict = findPlaceholderSecrets(env);
      expect(sorted(findings), JSON.stringify(value)).toEqual(
        sorted([
          ...verdict.placeholders.map((key) => `fatal ${key}`),
          ...verdict.warnOnly.map((key) => `warn ${key}`),
        ]),
      );
    }
  });

  it.skipIf(!HAS_AWK)(
    "fails the digest check exactly when digestsEnabled is misconfigured (C4)",
    () => {
      const smtp = [
        { SMTP_HOST: "mail.example.com", SMTP_PASS: "secret" },
        { SMTP_HOST: "mail.example.com", SMTP_PASS: "" },
        { SMTP_HOST: "", SMTP_PASS: "secret" },
      ];
      let misconfigured = 0;
      for (const disabled of ["0", "1"])
        for (const server of smtp)
          for (const from of ["Intranet <noreply@example.com>", "", "  "])
            for (const url of ["https://intranet.example.com", ""]) {
              const env = {
                DIGESTS_DISABLED: disabled,
                ...server,
                SMTP_USER: "digest@example.com",
                DIGEST_FROM: from,
                PUBLIC_WEB_URL: url,
              };
              const findings = runAwk(
                PREFLIGHT_AWK,
                { fatal_keys: "", warn_keys: "" },
                composeJson(env),
              );
              const gate = digestsEnabled(env);
              if (gate.kind === "misconfigured") misconfigured += 1;
              expect(
                findings.some((f) => f.startsWith("digest ")),
                JSON.stringify(env),
              ).toBe(gate.kind === "misconfigured");
            }
      // The table does reach the misconfigured branch.
      expect(misconfigured).toBeGreaterThan(0);
    },
  );

  it("makes the digest finding fatal, not a warning (C4)", () => {
    const block = DEPLOY.slice(DEPLOY.indexOf('if [[ -n "${digest_keys}" ]]; then'));
    expect(block.slice(0, block.indexOf("\nfi\n"))).toContain("preflight_failed=1");
    expect(DEPLOY).toMatch(/if \(\(preflight_failed\)\); then\n[^\n]*\n\s+exit 1/);
  });
});

describe("Microsoft sign-in gate (Strapi 5.51+)", () => {
  const GUID = "0b9d6c3e-4a1f-4c2b-9e8d-7f6a5b4c3d2e";

  it("keys on the same pair the web enables Microsoft sign-in with", () => {
    expect(WEB_AUTH_CONFIG).toContain(
      "process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET",
    );
    expect(COMPOSE).toContain("AUTH_MICROSOFT_ENTRA_ID_ID: ${MS_CLIENT_ID}");
    expect(COMPOSE).toContain("AUTH_MICROSOFT_ENTRA_ID_SECRET: ${MS_CLIENT_SECRET}");
  });

  it.skipIf(!HAS_AWK)("flags a real app registration and only warns about template text", () => {
    const cases: [string, string, string[]][] = [
      [GUID, "client-secret-value", ["entra MS_CLIENT_ID"]],
      [GUID.toUpperCase(), "client-secret-value", ["entra MS_CLIENT_ID"]],
      ["your-app-client-id", "your-app-client-secret", ["entra-template MS_CLIENT_ID"]],
      [`${GUID}0`, "client-secret-value", ["entra-template MS_CLIENT_ID"]],
      [GUID.replace(/-/g, ""), "client-secret-value", ["entra-template MS_CLIENT_ID"]],
      ["0b9d6c3e4-a1f-4c2b-9e8d-7f6a5b4c3d2e", "client-secret-value", ["entra-template MS_CLIENT_ID"]],
      ["0b9d6c3e-4a1f-4c2b-9e8d-7f6a5b4c3d2g", "client-secret-value", ["entra-template MS_CLIENT_ID"]],
      // The web needs both keys; with either one empty it offers no Microsoft sign-in.
      [GUID, "", []],
      ["", "client-secret-value", []],
      ["", "", []],
    ];
    for (const [id, secret, expected] of cases) {
      const findings = runAwk(
        PREFLIGHT_AWK,
        { fatal_keys: "", warn_keys: "" },
        composeJson({
          MS_CLIENT_ID: id,
          MS_CLIENT_SECRET: secret,
          AUTH_MICROSOFT_ENTRA_ID_ID: id,
          AUTH_MICROSOFT_ENTRA_ID_SECRET: secret,
        }),
      );
      expect(findings, JSON.stringify([id, secret])).toEqual(expected);
    }
  });

  it("makes a real app registration fatal and template text a warning", () => {
    const fatal = DEPLOY.slice(DEPLOY.indexOf('if [[ -n "${entra_keys}" ]]; then'));
    expect(fatal.slice(0, fatal.indexOf("\nfi\n"))).toContain("preflight_failed=1");
    const warning = DEPLOY.slice(DEPLOY.indexOf('if [[ -n "${entra_template_keys}" ]]; then'));
    expect(warning.slice(0, warning.indexOf("\nfi\n"))).not.toContain("preflight_failed");
    // Both run in the preflight, before anything is touched.
    expect(DEPLOY.indexOf('if [[ -n "${entra_keys}" ]]; then')).toBeLessThan(
      DEPLOY.indexOf('log "Preflight OK"'),
    );
  });
});

describe("D-SESSION-01 JWT rotation gate (C3)", () => {
  it("checks the label the web image carries", () => {
    const label = shellAssignment("JWT_OFF_SESSION_LABEL");
    const value = shellAssignment("JWT_OFF_SESSION_VALUE");
    expect(label).not.toBe("");
    expect(WEB_DOCKERFILE).toContain(`LABEL ${label}="${value}"`);
  });

  it("runs the gate in the preflight, before anything is touched", () => {
    const gate = DEPLOY.indexOf("if jwt_rotation_missing; then");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(DEPLOY.indexOf('log "Preflight OK"'));
    expect(gate).toBeLessThan(DEPLOY.indexOf('log "Pre-deploy database backup"'));
  });

  it.skipIf(!HAS_AWK)("extracts JWT_SECRET from compose JSON with Go escapes undone", () => {
    for (const secret of ["b64+/sEcReT==", "a&b<c>d", "with space", ""]) {
      const json = composeJson({ APP_KEYS: "k1,k2", JWT_SECRET: secret, JWT_SECRETX: "no" });
      expect(runAwk(ENV_VALUE_AWK, { want: "JWT_SECRET" }, json).join("\n")).toBe(secret);
    }
    expect(
      runAwk(ENV_VALUE_AWK, { want: "JWT_SECRET" }, composeJson({ JWT_SECRET: null })),
    ).toEqual([]);
  });
});

/** The body of a top-level shell function in deploy.sh, `name() {` to `}`. */
function shellFunction(name: string): string {
  const start = DEPLOY.indexOf(`\n${name}() {\n`);
  if (start < 0) throw new Error(`${name}() not found in infra/deploy.sh`);
  const end = DEPLOY.indexOf("\n}\n", start + 1);
  return DEPLOY.slice(start + 1, end + 2);
}

const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;

/**
 * Runs `script` in bash from stdin (no file path crosses from Windows into
 * the MSYS or WSL side) and returns what it wrote to stderr.
 */
function runBash(script: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** What the guest vote probes of the rollback hint see (poll guest access). */
interface GuestVoteStub {
  /** guest_poll_vote_grants output: the guest vote rows, "" = no db to ask. */
  grants: string;
  /** Exit code of the `docker run … grep visibleToGuests` image check. */
  imageCheck: number;
}

/**
 * print_rollback_hint with docker and the database probes stubbed:
 * `cmd` is what `docker image inspect -f '{{json .Config.Cmd}}'` prints for
 * infra-cms:rollback, null when that image does not exist. The real
 * image_has_poll_guest_access runs against the docker stub, which prints
 * its `docker run` arguments to stdout.
 */
function rollbackHintRun(
  cmd: string | null,
  naive = "0",
  guest: GuestVoteStub = { grants: "0", imageCheck: 0 },
): { stdout: string; stderr: string } {
  const script = [
    "set -euo pipefail",
    "PROJECT=infra",
    "SCRIPT_DIR=/srv/infra",
    "COMPOSE=(docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml)",
    "COMPOSE_LEGACY_TZ=/srv/infra/docker-compose.cms-legacy-tz.yml",
    `POLL_SCHEMA_IN_IMAGE=${shellQuote(shellAssignment("POLL_SCHEMA_IN_IMAGE"))}`,
    `STUB_CMD=${shellQuote(cmd ?? "")}`,
    `STUB_NAIVE=${shellQuote(naive)}`,
    `STUB_GRANTS=${shellQuote(guest.grants)}`,
    `STUB_IMAGE_CHECK=${guest.imageCheck}`,
    `naive_app_columns() { printf '%s\n' "\${STUB_NAIVE}"; }`,
    `guest_poll_vote_grants() { printf '%s\n' "\${STUB_GRANTS}"; }`,
    "docker() {",
    '  case "$1 ${2:-}" in',
    '    "image inspect") [[ -n "${STUB_CMD}" ]] || return 1; printf \'%s\\n\' "${STUB_CMD}" ;;',
    '    "run "*) printf \'docker %s\\n\' "$*"; return "${STUB_IMAGE_CHECK}" ;;',
    "    *) return 0 ;;",
    "  esac",
    "}",
    shellFunction("image_has_poll_guest_access"),
    shellFunction("print_guest_vote_revoke_hint"),
    shellFunction("print_rollback_hint"),
    "print_rollback_hint",
    "",
  ].join("\n");
  const res = runBash(script);
  expect(res.status, res.stderr).toBe(0);
  return { stdout: res.stdout, stderr: res.stderr };
}

const rollbackHint = (cmd: string | null, naive = "0", guest?: GuestVoteStub): string =>
  rollbackHintRun(cmd, naive, guest).stderr;

describe("rollback hint: cms images that start with pnpm", () => {
  const COMPOSE_LINE =
    "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";

  it("identifies such an image by its Cmd, not by a build date", () => {
    // The :rollback image of the fix's first deploy was built on the same
    // day as the fix, so a date told the operator the wrong thing.
    expect(DEPLOY).not.toMatch(/built before 20\d\d-\d\d-\d\d/);
    expect(shellFunction("print_rollback_hint")).toContain(
      `docker image inspect -f '{{json .Config.Cmd}}' "\${PROJECT}-cms:rollback"`,
    );
  });

  it.skipIf(!HAS_BASH)("prints the direct start for a :rollback image that runs pnpm start", () => {
    const hint = rollbackHint('["pnpm","start"]');
    expect(hint).toContain('infra-cms:rollback starts with pnpm (Cmd ["pnpm","start"])');
    expect(hint).toContain(`${COMPOSE_LINE} up -d --no-build web cms`);
    expect(hint).toContain(`${COMPOSE_LINE} -f /tmp/cms-direct-start.yml up -d --no-build web cms`);

    // The printed printf line, run as printed (minus the redirect), writes
    // the override file of docs/DEPLOYMENT.md.
    const printf = hint
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("printf "));
    expect(printf).toBeDefined();
    const redirect = " > /tmp/cms-direct-start.yml";
    expect(printf?.endsWith(redirect)).toBe(true);
    const written = runBash(`${printf?.slice(0, -redirect.length)}\n`);
    expect(written.status).toBe(0);
    expect(written.stdout).toBe(
      'services:\n  cms:\n    command: ["node_modules/.bin/strapi", "start"]\n',
    );
  });

  it.skipIf(!HAS_BASH)("adds the direct start after the legacy-zone override", () => {
    const hint = rollbackHint('["pnpm","start"]', "3");
    expect(hint).toContain(
      `${COMPOSE_LINE} -f /srv/infra/docker-compose.cms-legacy-tz.yml -f /tmp/cms-direct-start.yml up -d --no-build web cms`,
    );
  });

  it.skipIf(!HAS_BASH)("says nothing about pnpm for an image that starts Strapi directly", () => {
    const hint = rollbackHint('["node_modules/.bin/strapi","start"]');
    expect(hint).toContain(`${COMPOSE_LINE} up -d --no-build web cms`);
    expect(hint).not.toContain("pnpm");
  });

  it.skipIf(!HAS_BASH)("prints the Cmd check when there is no :rollback image to inspect", () => {
    const hint = rollbackHint(null);
    expect(hint).toContain("docker image inspect -f '{{json .Config.Cmd}}' infra-cms:rollback");
    expect(hint).toContain('(Cmd ["pnpm","start"])');
    expect(hint).not.toContain("cms-direct-start.yml up");
  });
});

describe("rollback hint: the guest vote permission of poll guest access", () => {
  const COMPOSE_LINE =
    "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";
  const REVOKE_SQL = "infra/rollback/revoke-guest-poll-vote.sql";
  const PSQL = 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"';
  const REVOKE_LINE = `${COMPOSE_LINE} exec -T db sh -c '${PSQL}' < /srv/${REVOKE_SQL}`;
  const IMAGE_CHECK =
    "docker run --rm --pull never --network none --entrypoint grep infra-cms:rollback -q visibleToGuests /app/apps/cms/src/api/poll/content-types/poll/schema.json";

  it("checks the in-image path of the poll schema that the cms Dockerfile ships", () => {
    const path = shellAssignment("POLL_SCHEMA_IN_IMAGE");
    expect(path).toBe("/app/apps/cms/src/api/poll/content-types/poll/schema.json");
    // The runner stage copies the builder's /app, which holds apps/cms from the build context.
    const dockerfile = read("apps", "cms", "Dockerfile");
    expect(dockerfile).toContain("COPY apps/cms ./apps/cms");
    expect(dockerfile).toContain("COPY --from=builder --chown=node:node /app /app");
    expect(read(...path.replace(/^\/app\//, "").split("/"))).toContain('"visibleToGuests"');
  });

  it("revokes exactly the guest role's poll vote permission, in one transaction", () => {
    const sql = read(...REVOKE_SQL.split("/"));
    const statements = sql
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    const writes = statements.filter((s) => /^(DELETE|UPDATE|INSERT)\b/i.test(s));
    expect(writes).toEqual([
      "DELETE FROM up_permissions_role_lnk l USING up_permissions p, up_roles r WHERE l.permission_id = p.id AND l.role_id = r.id AND r.type = 'guest' AND p.action = 'api::poll-vote.poll-vote.vote'",
      "DELETE FROM up_permissions p WHERE p.action = 'api::poll-vote.poll-vote.vote' AND NOT EXISTS (SELECT 1 FROM up_permissions_role_lnk l WHERE l.permission_id = p.id)",
    ]);
    // The action the cms grants every role, guest included, and the probe deploy.sh runs.
    expect(read("apps", "cms", "src", "index.ts")).toContain('"api::poll-vote.poll-vote.vote": "*"');
    expect(shellFunction("guest_poll_vote_grants")).toContain(
      "WHERE r.type = 'guest' AND p.action = 'api::poll-vote.poll-vote.vote'",
    );
  });

  it.skipIf(!HAS_BASH)("prints the removal BEFORE the retag for a :rollback cms from before guest access", () => {
    const { stdout, stderr } = rollbackHintRun('["node_modules/.bin/strapi","start"]', "0", {
      grants: "1",
      imageCheck: 1,
    });
    expect(stdout).toContain(IMAGE_CHECK);
    expect(stderr).toContain("FIRST, before the retag: infra-cms:rollback predates poll guest access.");
    expect(stderr).toContain(`${COMPOSE_LINE} stop cms`);
    expect(stderr).toContain(REVOKE_LINE);
    expect(stderr).toContain("both DELETEs must report 0");
    expect(stderr.indexOf("FIRST")).toBeLessThan(stderr.indexOf("To roll back:"));
    expect(stderr.indexOf(`${COMPOSE_LINE} stop cms`)).toBeLessThan(stderr.indexOf("To roll back:"));
    expect(stderr).toContain(`${COMPOSE_LINE} up -d --no-build web cms`);
  });

  it.skipIf(!HAS_BASH)("prints it too when the database cannot be asked", () => {
    const hint = rollbackHint('["node_modules/.bin/strapi","start"]', "0", { grants: "", imageCheck: 1 });
    expect(hint).toContain(REVOKE_LINE);
  });

  it.skipIf(!HAS_BASH)("prints it with the image check when the :rollback image cannot be checked", () => {
    const hint = rollbackHint(null, "0", { grants: "1", imageCheck: 125 });
    expect(hint).toContain("if infra-cms:rollback predates poll guest access (this prints 0 then):");
    expect(hint).toContain(IMAGE_CHECK.replace(" -q ", " -c "));
    expect(hint).toContain(REVOKE_LINE);
    expect(hint.indexOf("FIRST")).toBeLessThan(hint.indexOf("To roll back:"));
  });

  it.skipIf(!HAS_BASH)("says nothing when the database has no guest vote row", () => {
    const { stdout, stderr } = rollbackHintRun('["node_modules/.bin/strapi","start"]', "0", {
      grants: "0",
      imageCheck: 1,
    });
    expect(stdout).not.toContain("docker run");
    expect(stderr).not.toContain("FIRST");
    expect(stderr).not.toContain(REVOKE_SQL);
  });

  it.skipIf(!HAS_BASH)("says nothing when the :rollback cms knows guest access (the row is its own grant)", () => {
    const hint = rollbackHint('["node_modules/.bin/strapi","start"]', "0", { grants: "1", imageCheck: 0 });
    expect(hint).not.toContain("FIRST");
    expect(hint).not.toContain(REVOKE_SQL);
    expect(hint).toContain(`${COMPOSE_LINE} up -d --no-build web cms`);
  });

  it.skipIf(!HAS_BASH)("prints a removal command that the shell splits into the psql call of DEPLOYMENT", () => {
    const hint = rollbackHint('["node_modules/.bin/strapi","start"]', "0", { grants: "1", imageCheck: 1 });
    const line = hint
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.includes(" exec -T db "));
    expect(line).toBeDefined();
    const redirect = ` < /srv/${REVOKE_SQL}`;
    expect(line?.endsWith(redirect)).toBe(true);
    // Run as printed (minus the redirect) with docker printing one argument per line.
    const run = runBash(`docker() { printf '%s\n' "$@"; }\n${line?.slice(0, -redirect.length)}\n`);
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd().split("\n").slice(-4)).toEqual(["db", "sh", "-c", PSQL]);
  });
});
