import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digestsEnabled } from "../digest/send-digests";
import { EntraConfigError, parseEntraConfig } from "../entra/config";
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
 *   4. the Entra preflight (D-ENTRA-01) refuses exactly the settings the
 *      cms (entra/config.ts parseEntraConfig) and the web refuse to start
 *      with when ENTRA_ENABLED=1, is fatal, and without it only warns about
 *      a real app registration (GUID client id plus secret: Microsoft
 *      sign-in of the running release goes off) and notes other stale MS_*
 *      keys, both with exit code 0; compose hands both apps the keys they
 *      read,
 *   5. the rollback hint of a failed deploy tells a cms image that still
 *      starts with pnpm by its Cmd and prints a working direct start (runs
 *      the real function with docker stubbed where `bash` exists),
 *   6. for a :rollback cms from before poll guest access, or one it cannot
 *      check, it prints the whole guest vote sequence whatever the database
 *      holds: stop the cms, remove the permission
 *      (infra/rollback/revoke-guest-poll-vote.sql), retag and start, remove
 *      again; nothing for a :rollback cms that knows guest access,
 *   7. every docker call of the hint is bounded (timeout; the naive query
 *      also by lock and statement timeouts), and a probe that fails or
 *      times out prints the safe variant, never fewer lines,
 *   8. datetime phase 2: the web runs in UTC (image and compose), and the
 *      hint adds infra/docker-compose.web-legacy-tz.yml for a :rollback web
 *      without the org.sinnlos.datetime label apps/web/Dockerfile sets (or
 *      one it cannot check); that override restores exactly the TZ the
 *      compose file gave the web before the port,
 *   9. FX35: the hint names the rollback target of the deploy (the SHA tag
 *      of the last-known-good state, :rollback without one, nothing on a
 *      fresh install) and runs every probe on that target's images,
 *  10. B05: the preflight reads DIGESTS_DISABLED like the cms
 *      (parseEnvFlag: 1/true/yes/on, trimmed, any case), and live-smoke's
 *      switches come from the env compose hands the apps
 *      (LIVE_EVENTS_DISABLED, the Entra-only case), not from the shell.
 * The state, tag and lock logic of FX35 (and a full stubbed deploy) is
 * pinned in infra/deploy-flow.test.ts.
 *
 * The SQL itself runs against Postgres 16 in
 * revoke-guest-poll-vote.pg.test.ts.
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

  it.skipIf(!HAS_AWK)(
    "gives the same placeholder verdict as findPlaceholderSecrets",
    () => {
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
    },
    30_000,
  );

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
    30_000,
  );

  it.skipIf(!HAS_AWK)(
    "reads every DIGESTS_DISABLED spelling as the cms does (B05, parseEnvFlag)",
    () => {
      // SMTP set, the sender missing: misconfigured unless the switch is on.
      const base = {
        SMTP_HOST: "mail.example.com",
        SMTP_USER: "u",
        SMTP_PASS: "p",
        DIGEST_FROM: "",
      };
      let onButNotOne = 0;
      for (const disabled of [
        "0",
        "1",
        "true",
        " TRUE ",
        "Yes",
        "on",
        "ON",
        "off",
        "no",
        "false",
        "",
        "2",
        "enabled",
      ]) {
        const env = {
          ...base,
          PUBLIC_WEB_URL: "https://intranet.example.com",
          DIGESTS_DISABLED: disabled,
        };
        const findings = runAwk(PREFLIGHT_AWK, { fatal_keys: "", warn_keys: "" }, composeJson(env));
        const gate = digestsEnabled(env);
        if (gate.kind === "skip" && disabled.trim() !== "1") onButNotOne += 1;
        expect(findings.includes("digest DIGEST_FROM"), JSON.stringify(disabled)).toBe(
          gate.kind === "misconfigured",
        );
      }
      // Spellings other than 1 that switch the digests off do occur in the table.
      expect(onButNotOne).toBe(5);
    },
    30_000,
  );

  it("reads DIGESTS_DISABLED through the cms's switch rule, not as the string 1", () => {
    expect(PREFLIGHT_AWK).toContain('if (!flag(env["DIGESTS_DISABLED"]) && env["SMTP_HOST"] != ""');
    expect(PREFLIGHT_AWK).not.toContain('env["DIGESTS_DISABLED"] != "1"');
  });

  it("makes the digest finding fatal, not a warning (C4)", () => {
    const block = DEPLOY.slice(DEPLOY.indexOf('if [[ -n "${digest_keys}" ]]; then'));
    expect(block.slice(0, block.indexOf("\nfi\n"))).toContain("preflight_failed=1");
    expect(DEPLOY).toMatch(/if \(\(preflight_failed\)\); then\n[^\n]*\n\s+exit 1/);
  });
});

describe("Entra preflight (D-ENTRA-01)", () => {
  const TENANT = "11111111-2222-4333-8444-555555555555";
  const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const GROUP = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const SECRET = "0123456789abcdef0123456789abcdef";

  /** The cms and web env compose builds from one infra/.env (the Entra keys). */
  function composeEnv(env: Record<string, string>): Record<string, string> {
    return {
      ENTRA_ENABLED: env.ENTRA_ENABLED ?? "0",
      MS_TENANT_ID: env.MS_TENANT_ID ?? "",
      MS_CLIENT_ID: env.MS_CLIENT_ID ?? "",
      ENTRA_EXCHANGE_SECRET: env.ENTRA_EXCHANGE_SECRET ?? "",
      ENTRA_SYNC_MODE: env.ENTRA_SYNC_MODE ?? "dry-run",
      ENTRA_DEFAULT_ROLE: env.ENTRA_DEFAULT_ROLE ?? "member",
      ENTRA_GROUP_ROLES: env.ENTRA_GROUP_ROLES ?? "",
      ENTRA_SESSION_TTL: env.ENTRA_SESSION_TTL ?? "12h",
      AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: env.MS_TENANT_ID ?? "",
      AUTH_MICROSOFT_ENTRA_ID_ID: env.MS_CLIENT_ID ?? "",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: env.MS_CLIENT_SECRET ?? "",
    };
  }

  /**
   * What the cms (parseEntraConfig) and the web (a non-empty client
   * secret; its GUID and exchange-secret rules equal the cms's) refuse, as
   * infra/.env keys.
   */
  function refusedByTheApps(env: Record<string, string>): string[] {
    const keys: string[] = [];
    const composed = composeEnv(env);
    try {
      parseEntraConfig(composed);
    } catch (err) {
      if (!(err instanceof EntraConfigError)) throw err;
      keys.push(...err.issues.map((issue) => issue.variable));
    }
    if (composed.ENTRA_ENABLED === "1" && composed.AUTH_MICROSOFT_ENTRA_ID_SECRET.trim() === "") {
      keys.push("MS_CLIENT_SECRET");
    }
    return keys.map((key) => `entra-invalid ${key}`);
  }

  const valid = {
    ENTRA_ENABLED: "1",
    MS_TENANT_ID: TENANT,
    MS_CLIENT_ID: CLIENT,
    MS_CLIENT_SECRET: "client-secret-value",
    ENTRA_EXCHANGE_SECRET: SECRET,
  };
  const groups = (n: number) =>
    Array.from({ length: n }, (_, i) => `member:${GROUP(i + 1)}`).join(",");

  const CASES: Record<string, string>[] = [
    valid,
    { ...valid, MS_TENANT_ID: TENANT.toUpperCase(), MS_CLIENT_ID: ` ${CLIENT} ` },
    { ...valid, MS_TENANT_ID: "common" },
    { ...valid, MS_TENANT_ID: "organizations" },
    { ...valid, MS_TENANT_ID: "contoso.onmicrosoft.com" },
    { ...valid, MS_TENANT_ID: "<directory-tenant-guid>" },
    { ...valid, MS_TENANT_ID: `${TENANT}0` },
    { ...valid, MS_CLIENT_ID: "your-app-client-id" },
    { ...valid, MS_CLIENT_ID: CLIENT.replace(/-/g, "") },
    { ...valid, MS_CLIENT_SECRET: "" },
    { ...valid, MS_CLIENT_SECRET: "  " },
    { ...valid, ENTRA_EXCHANGE_SECRET: "" },
    { ...valid, ENTRA_EXCHANGE_SECRET: "x".repeat(31) },
    { ...valid, ENTRA_EXCHANGE_SECRET: "x".repeat(32) },
    { ...valid, ENTRA_EXCHANGE_SECRET: ` ${"y".repeat(30)} ` },
    { ...valid, ENTRA_EXCHANGE_SECRET: `change-me-${"z".repeat(30)}` },
    { ...valid, ENTRA_EXCHANGE_SECRET: `<openssl rand -hex 32 ${"z".repeat(20)}>` },
    { ...valid, ENTRA_SYNC_MODE: "on" },
    { ...valid, ENTRA_SYNC_MODE: "" },
    { ...valid, ENTRA_SYNC_MODE: "ON" },
    { ...valid, ENTRA_SYNC_MODE: "dryrun" },
    { ...valid, ENTRA_DEFAULT_ROLE: "deny" },
    { ...valid, ENTRA_DEFAULT_ROLE: "guest" },
    { ...valid, ENTRA_DEFAULT_ROLE: "editor" },
    { ...valid, ENTRA_SESSION_TTL: "7d" },
    { ...valid, ENTRA_SESSION_TTL: "168h" },
    { ...valid, ENTRA_SESSION_TTL: "10080m" },
    { ...valid, ENTRA_SESSION_TTL: "30m" },
    { ...valid, ENTRA_SESSION_TTL: "" },
    { ...valid, ENTRA_SESSION_TTL: "8d" },
    { ...valid, ENTRA_SESSION_TTL: "10081m" },
    { ...valid, ENTRA_SESSION_TTL: "0h" },
    { ...valid, ENTRA_SESSION_TTL: "12" },
    { ...valid, ENTRA_SESSION_TTL: "1w" },
    { ...valid, ENTRA_SESSION_TTL: "99999999999999999999h" },
    {
      ...valid,
      ENTRA_GROUP_ROLES: `editor:${GROUP(1)}, admin_role:${GROUP(1).toUpperCase()},,member:${GROUP(2)}`,
    },
    { ...valid, ENTRA_GROUP_ROLES: `admin:${GROUP(1)}` },
    { ...valid, ENTRA_GROUP_ROLES: "editor:Intranet-Editors" },
    { ...valid, ENTRA_GROUP_ROLES: GROUP(1) },
    { ...valid, ENTRA_GROUP_ROLES: "member" },
    { ...valid, ENTRA_GROUP_ROLES: groups(20) },
    { ...valid, ENTRA_GROUP_ROLES: groups(21) },
    { ENTRA_ENABLED: "1" },
    {
      ENTRA_ENABLED: "1",
      MS_TENANT_ID: "common",
      ENTRA_SYNC_MODE: "sometimes",
      ENTRA_SESSION_TTL: "8d",
    },
  ];

  it.skipIf(!HAS_AWK)(
    "refuses exactly what the cms and the web refuse to start with",
    () => {
      let refusedSome = 0;
      for (const env of CASES) {
        const findings = runAwk(
          PREFLIGHT_AWK,
          { fatal_keys: "", warn_keys: "" },
          composeJson(composeEnv(env)),
        );
        const expected = refusedByTheApps(env);
        if (expected.length > 0) refusedSome += 1;
        expect(sorted(findings), JSON.stringify(env)).toEqual(sorted(expected));
      }
      expect(refusedSome).toBeGreaterThan(20);
    },
    30_000,
  );

  it.skipIf(!HAS_AWK)(
    "ignores every MS_*/ENTRA_* value without ENTRA_ENABLED=1, noting stale MS_* keys",
    () => {
      const stale = {
        MS_TENANT_ID: "your-tenant-guid-or-common",
        MS_CLIENT_ID: "your-app-client-id",
        MS_CLIENT_SECRET: "your-app-client-secret",
        ENTRA_EXCHANGE_SECRET: "short",
        ENTRA_SYNC_MODE: "bogus",
      };
      for (const flag of ["0", "", "true", "yes", " 1"]) {
        const findings = runAwk(
          PREFLIGHT_AWK,
          { fatal_keys: "", warn_keys: "" },
          composeJson(composeEnv({ ...stale, ENTRA_ENABLED: flag })),
        );
        expect(findings, flag).toEqual(["entra-inert MS_CLIENT_ID"]);
        expect(refusedByTheApps({ ...stale, ENTRA_ENABLED: flag }), flag).toEqual([]);
      }
      const clean = runAwk(
        PREFLIGHT_AWK,
        { fatal_keys: "", warn_keys: "" },
        composeJson(composeEnv({})),
      );
      expect(clean).toEqual([]);
    },
  );

  it.skipIf(!HAS_AWK)(
    "tells a real app registration without ENTRA_ENABLED=1 (entra-was-on) from template values (entra-inert)",
    () => {
      const scan = (env: Record<string, string>) =>
        runAwk(PREFLIGHT_AWK, { fatal_keys: "", warn_keys: "" }, composeJson(composeEnv(env)));
      const registration = {
        MS_TENANT_ID: TENANT,
        MS_CLIENT_ID: CLIENT,
        MS_CLIENT_SECRET: "s3cr3t",
      };
      for (const flag of ["0", "", "true"]) {
        expect(scan({ ...registration, ENTRA_ENABLED: flag }), flag).toEqual([
          "entra-was-on MS_CLIENT_ID",
        ]);
      }
      expect(scan({ ...registration, MS_CLIENT_ID: ` ${CLIENT.toUpperCase()} ` })).toEqual([
        "entra-was-on MS_CLIENT_ID",
      ]);
      // Not a working registration: a template client id, or one key alone.
      for (const env of [
        { ...registration, MS_CLIENT_ID: "your-app-client-id" },
        { ...registration, MS_CLIENT_SECRET: "" },
        { ...registration, MS_CLIENT_SECRET: "   " },
        { MS_CLIENT_SECRET: "s3cr3t" },
      ]) {
        expect(scan(env), JSON.stringify(env)).toEqual(["entra-inert MS_CLIENT_ID"]);
      }
      // With ENTRA_ENABLED=1 the same registration is a valid configuration.
      expect(scan({ ...registration, ENTRA_ENABLED: "1", ENTRA_EXCHANGE_SECRET: SECRET })).toEqual(
        [],
      );
    },
  );

  it("makes an invalid Entra configuration fatal and stale MS_* keys a warning or a note, in the preflight", () => {
    const invalidGate = 'if [[ -n "${entra_invalid_keys}" ]]; then';
    const wasOnGate = 'if [[ -n "${entra_was_on_keys}" ]]; then';
    const inertGate = 'if [[ -n "${entra_inert_keys}" ]]; then';
    const fatal = DEPLOY.slice(DEPLOY.indexOf(invalidGate));
    expect(fatal.slice(0, fatal.indexOf("\nfi\n"))).toContain("preflight_failed=1");
    for (const gate of [wasOnGate, inertGate]) {
      const block = DEPLOY.slice(DEPLOY.indexOf(gate));
      expect(block.slice(0, block.indexOf("\nfi\n")), gate).not.toContain("preflight_failed");
    }
    for (const gate of [invalidGate, wasOnGate, inertGate]) {
      expect(DEPLOY.indexOf(gate), gate).toBeGreaterThan(-1);
      expect(DEPLOY.indexOf(gate), gate).toBeLessThan(DEPLOY.indexOf('log "Preflight OK"'));
    }
    // The old "Microsoft sign-in cannot complete" refusal is gone.
    expect(DEPLOY).not.toContain("entra_template_keys");
  });

  it("wires the env as the apps read it (compose)", () => {
    const service = (name: string) => {
      const start = COMPOSE.indexOf(`\n  ${name}:\n`);
      const next = COMPOSE.slice(start + 1).search(/\n {2}[a-z]+:\n/);
      return COMPOSE.slice(start, next < 0 ? undefined : start + 1 + next);
    };
    const cms = service("cms");
    const web = service("web");
    for (const line of [
      "ENTRA_ENABLED: ${ENTRA_ENABLED:-0}",
      "MS_TENANT_ID: ${MS_TENANT_ID:-}",
      "MS_CLIENT_ID: ${MS_CLIENT_ID:-}",
      "ENTRA_EXCHANGE_SECRET: ${ENTRA_EXCHANGE_SECRET:-}",
      "ENTRA_SYNC_MODE: ${ENTRA_SYNC_MODE:-dry-run}",
      "ENTRA_DEFAULT_ROLE: ${ENTRA_DEFAULT_ROLE:-member}",
      "ENTRA_GROUP_ROLES: ${ENTRA_GROUP_ROLES:-}",
      "ENTRA_SYNC_DEPARTMENT: ${ENTRA_SYNC_DEPARTMENT:-0}",
      "ENTRA_SYNC_MANAGER: ${ENTRA_SYNC_MANAGER:-0}",
      "ENTRA_SESSION_TTL: ${ENTRA_SESSION_TTL:-12h}",
      "AUTH_LOCAL_ENABLED: ${AUTH_LOCAL_ENABLED:-0}",
    ]) {
      expect(cms, line).toContain(line);
    }
    for (const line of [
      "ENTRA_ENABLED: ${ENTRA_ENABLED:-0}",
      "AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: ${MS_TENANT_ID:-}",
      "AUTH_MICROSOFT_ENTRA_ID_ID: ${MS_CLIENT_ID:-}",
      "AUTH_MICROSOFT_ENTRA_ID_SECRET: ${MS_CLIENT_SECRET:-}",
      "ENTRA_EXCHANGE_SECRET: ${ENTRA_EXCHANGE_SECRET:-}",
      "ENTRA_SYNC_MANAGER: ${ENTRA_SYNC_MANAGER:-0}",
      "AUTH_LOCAL_ENABLED: ${AUTH_LOCAL_ENABLED:-0}",
    ]) {
      expect(web, line).toContain(line);
    }
    // The cms never needs the client secret; the issuer is computed.
    expect(cms).not.toContain("MS_CLIENT_SECRET");
    expect(COMPOSE).not.toContain("AUTH_MICROSOFT_ENTRA_ID_ISSUER:");
    // The same switch in the web (lib/auth-config.ts).
    expect(WEB_AUTH_CONFIG).toContain('env.ENTRA_ENABLED !== "1"');
    expect(WEB_AUTH_CONFIG).toContain("AUTH_MICROSOFT_ENTRA_ID_SECRET");
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
/** Test budget for the cases that start bash (see runBash). */
const BASH_BUDGET = { timeout: 30_000 };
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;

/**
 * Runs `script` in bash from stdin (no file path crosses from Windows into
 * the MSYS or WSL side) and returns what it wrote to stderr.
 */
function runBash(script: string): { status: number | null; stdout: string; stderr: string } {
  // A bash start costs about 0.1-1 s alone but took 8 s under a full
  // parallel run on Windows (Git Bash), so every describe whose cases call
  // this carries BASH_BUDGET (docs/architecture.md §5.40 "Last-Timeouts").
  const res = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A top-level deploy.sh line that starts with `prefix`, e.g. an array assignment. */
function shellLine(prefix: string): string {
  const line = DEPLOY.split("\n").find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`${prefix} not found in infra/deploy.sh`);
  return line;
}

/** What the probes of the rollback hint see. */
interface HintProbes {
  /**
   * What the naive-column query prints through `docker exec` ("" = the
   * database could not be asked). Default "0".
   */
  naive?: string;
  /**
   * Exit code of the `docker run … grep visibleToGuests` image check: 0 the
   * :rollback cms knows poll guest access (default), 1 it predates it,
   * anything else unknown.
   */
  imageCheck?: number;
  /**
   * docker subcommands ("exec", "image", "run") that hang: the `timeout`
   * stub ends them with 124, as the real one does at the deadline.
   */
  hang?: string[];
  /**
   * What `docker image inspect -f '{{ index .Config.Labels
   * "org.sinnlos.datetime" }}'` prints for the target web image: default
   * "zone-explicit" (a web from the datetime port on), "<no value>" for an
   * older one (docker 29 prints an empty line there; any other value counts
   * as older), null when that image does not exist.
   */
  webLabel?: string | null;
  /**
   * The rollback target (ROLLBACK_REF): "rollback" (default, the images this
   * run tagged without a state), a 12-digit SHA tag of the last-known-good
   * state, or "" (nothing to roll back to).
   */
  ref?: string;
}

/** The state file the hint names for a SHA target (harness value). */
const STATE_FILE_STUB = "/srv/.git/sinnlos-deploy/infra.state";

/**
 * print_rollback_hint with docker and `timeout` stubbed and the real probe
 * functions of deploy.sh: `cmd` is what `docker image inspect -f
 * '{{json .Config.Cmd}}'` prints for the target cms image
 * (infra-cms:<ref>), null when that image does not exist. The docker stub
 * logs every call to stdout (fd 3, also from inside a command
 * substitution) as "bounded docker …" when it runs under the `timeout` stub
 * and "UNBOUNDED docker …" otherwise, and "permission probe" when a query
 * it is handed reads up_permissions.
 */
function rollbackHintRun(
  cmd: string | null,
  probes: HintProbes = {},
): { stdout: string; stderr: string } {
  const ref = probes.ref ?? "rollback";
  const script = [
    "set -euo pipefail",
    "exec 3>&1",
    "PROJECT=infra",
    "INFRA_DIR=/srv/infra",
    "COMPOSE=(docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml)",
    "COMPOSE_LEGACY_TZ=/srv/infra/docker-compose.cms-legacy-tz.yml",
    "COMPOSE_WEB_LEGACY_TZ=/srv/infra/docker-compose.web-legacy-tz.yml",
    `ROLLBACK_REF=${shellQuote(ref)}`,
    `ROLLBACK_ORIGIN=${shellQuote(ref === "rollback" ? "the images that ran before this deploy (:rollback)" : ref ? `the last-known-good deploy ${ref} (2026-09-29T10:00:00+02:00)` : "")}`,
    `STATE_FILE=${STATE_FILE_STUB}`,
    shellLine("PROBE_TIMEOUT=("),
    shellLine("WEB_DATETIME_LABEL="),
    shellLine("WEB_DATETIME_VALUE="),
    `POLL_SCHEMA_IN_IMAGE=${shellQuote(shellAssignment("POLL_SCHEMA_IN_IMAGE"))}`,
    shellLine("REVOKE_GUEST_VOTE_PSQL="),
    `STUB_CMD=${shellQuote(cmd ?? "")}`,
    `STUB_NAIVE=${shellQuote(probes.naive ?? "0")}`,
    `STUB_IMAGE_CHECK=${probes.imageCheck ?? 0}`,
    `STUB_HANG=${shellQuote(` ${(probes.hang ?? []).join(" ")} `)}`,
    `STUB_WEB_LABEL=${shellQuote(probes.webLabel === undefined ? "zone-explicit" : (probes.webLabel ?? ""))}`,
    "BOUNDED=0",
    "timeout() {",
    '  while [[ "$1" != docker ]]; do shift; done',
    '  if [[ "${STUB_HANG}" == *" $2 "* ]]; then return 124; fi',
    '  local rc=0; BOUNDED=1; "$@" || rc=$?; BOUNDED=0; return "${rc}"',
    "}",
    "docker() {",
    "  if ((BOUNDED)); then printf 'bounded docker %s\\n' \"$*\" >&3; else printf 'UNBOUNDED docker %s\\n' \"$*\" >&3; fi",
    '  case "$1 ${2:-}" in',
    '    "image inspect")',
    '      if [[ "$*" == *" infra-web:"* ]]; then',
    '        [[ -n "${STUB_WEB_LABEL}" ]] || return 1; printf \'%s\\n\' "${STUB_WEB_LABEL}"; return 0',
    "      fi",
    '      [[ -n "${STUB_CMD}" ]] || return 1; printf \'%s\\n\' "${STUB_CMD}" ;;',
    '    "run "*) return "${STUB_IMAGE_CHECK}" ;;',
    '    "exec "*)',
    '      if [[ "$(cat)" == *up_permissions* ]]; then echo "permission probe" >&3; fi',
    '      [[ -n "${STUB_NAIVE}" ]] || return 1; printf \'%s\\n\' "${STUB_NAIVE}" ;;',
    "    *) return 0 ;;",
    "  esac",
    "}",
    shellFunction("naive_app_columns"),
    shellFunction("image_has_poll_guest_access"),
    shellFunction("image_web_zone_explicit"),
    shellFunction("print_guest_vote_revoke_hint"),
    shellFunction("print_guest_vote_recheck_hint"),
    shellFunction("print_rollback_hint"),
    "print_rollback_hint",
    "",
  ].join("\n");
  const res = runBash(script);
  expect(res.status, res.stderr).toBe(0);
  return { stdout: res.stdout, stderr: res.stderr };
}

const rollbackHint = (cmd: string | null, naive = "0", probes: HintProbes = {}): string =>
  rollbackHintRun(cmd, { naive, ...probes }).stderr;

/** Asserts that `text` holds the needles in this order, each after the one before. */
function expectInOrder(text: string, needles: readonly string[]): void {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    expect(at, `"${needle}" after offset ${from} in:\n${text}`).toBeGreaterThanOrEqual(0);
    from = at + needle.length;
  }
}

describe("rollback hint: cms images that start with pnpm", BASH_BUDGET, () => {
  const COMPOSE_LINE =
    "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";

  it("identifies such an image by its Cmd, not by a build date", () => {
    // The :rollback image of the fix's first deploy was built on the same
    // day as the fix, so a date told the operator the wrong thing.
    expect(DEPLOY).not.toMatch(/built before 20\d\d-\d\d-\d\d/);
    const hint = shellFunction("print_rollback_hint");
    expect(hint).toContain('cms_image="${PROJECT}-cms:${ROLLBACK_REF}"');
    expect(hint).toContain(`docker image inspect -f '{{json .Config.Cmd}}' "\${cms_image}"`);
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

describe("rollback hint: the guest vote permission of poll guest access", BASH_BUDGET, () => {
  const COMPOSE_LINE =
    "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";
  const REVOKE_SQL = "infra/rollback/revoke-guest-poll-vote.sql";
  const PSQL = 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"';
  const REVOKE_LINE = `${COMPOSE_LINE} exec -T db sh -c '${PSQL}' < /srv/${REVOKE_SQL}`;
  const IMAGE_CHECK =
    "docker run --rm --pull never --network none --entrypoint grep infra-cms:rollback -q visibleToGuests /app/apps/cms/src/api/poll/content-types/poll/schema.json";
  const STRAPI_CMD = '["node_modules/.bin/strapi","start"]';
  /**
   * The whole sequence, in the order the operator runs it: stop the cms,
   * remove, retag and start, remove again (it must find nothing).
   */
  const FULL_SEQUENCE = [
    `${COMPOSE_LINE} stop cms`,
    REVOKE_LINE,
    "To roll back to ",
    "docker tag infra-web:rollback infra-web:latest",
    "docker tag infra-cms:rollback infra-cms:latest",
    `${COMPOSE_LINE} up -d --no-build web cms`,
    "THEN, once the previous cms is up, run the removal again. It must remove nothing",
    "(guest_links_removed 0, permission_rows_removed 0)",
    REVOKE_LINE,
    "tags whatever runs then as :rollback",
  ];

  it("checks the in-image path of the poll schema that the cms Dockerfile ships", () => {
    const path = shellAssignment("POLL_SCHEMA_IN_IMAGE");
    expect(path).toBe("/app/apps/cms/src/api/poll/content-types/poll/schema.json");
    // The runner stage copies the builder's /app, which holds apps/cms from the build context.
    const dockerfile = read("apps", "cms", "Dockerfile");
    expect(dockerfile).toContain("COPY apps/cms ./apps/cms");
    expect(dockerfile).toContain("COPY --from=builder --chown=node:node /app /app");
    expect(read(...path.replace(/^\/app\//, "").split("/"))).toContain('"visibleToGuests"');
  });

  it("removes only the guest role's links and the permission rows it unlinked, in one transaction", () => {
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
    // One writing statement: both DELETEs in data-modifying CTEs, so the
    // second one can only reach the rows the first one returns.
    const writes = statements.filter((s) =>
      /\b(DELETE|UPDATE|INSERT|TRUNCATE|DROP|ALTER)\b/i.test(s),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(
      "WITH unlinked AS ( " +
        "DELETE FROM up_permissions_role_lnk l USING up_permissions p, up_roles r " +
        "WHERE l.permission_id = p.id AND l.role_id = r.id AND r.type = 'guest' " +
        "AND p.action = 'api::poll-vote.poll-vote.vote' " +
        "RETURNING l.id, l.permission_id " +
        "), removed AS ( " +
        "DELETE FROM up_permissions p WHERE p.id IN (SELECT permission_id FROM unlinked) " +
        "AND NOT EXISTS (SELECT 1 FROM up_permissions_role_lnk l WHERE l.permission_id = p.id " +
        "AND l.id NOT IN (SELECT id FROM unlinked)) " +
        "RETURNING p.id " +
        ") SELECT (SELECT count(*) FROM unlinked) AS guest_links_removed, " +
        "(SELECT count(*) FROM removed) AS permission_rows_removed",
    );
    // The action the cms grants every role, guest included.
    expect(read("apps", "cms", "src", "bootstrap", "permission-matrix.ts")).toContain(
      '"api::poll-vote.poll-vote.vote": "*"',
    );
  });

  it.skipIf(!HAS_BASH)(
    "prints the whole sequence for a :rollback cms from before guest access",
    () => {
      const { stdout, stderr } = rollbackHintRun(STRAPI_CMD, { imageCheck: 1 });
      expect(stdout).toContain(`bounded ${IMAGE_CHECK}`);
      expect(stderr).toContain(
        "FIRST, before the retag: infra-cms:rollback predates poll guest access.",
      );
      expect(stderr).toContain("also when the database or the admin panel shows none");
      expectInOrder(stderr, ["FIRST, before the retag", ...FULL_SEQUENCE]);
    },
  );

  it.skipIf(!HAS_BASH)(
    "prints it whatever the database holds: it never asks for the permission",
    () => {
      // A slow first boot can miss compose's health deadline before its
      // bootstrap grants the row: the database holds none (every query
      // answers 0 here), and the still starting or restarting new cms grants
      // it afterwards.
      const { stdout, stderr } = rollbackHintRun(STRAPI_CMD, { naive: "0", imageCheck: 1 });
      expect(stdout).not.toContain("permission probe");
      expectInOrder(stderr, FULL_SEQUENCE);
      expect(DEPLOY).not.toContain("guest_poll_vote_grants");
    },
  );

  it.skipIf(!HAS_BASH)(
    "prints it with the image check when the :rollback image cannot be checked",
    () => {
      for (const imageCheck of [2, 125, 127]) {
        const hint = rollbackHint(null, "0", { imageCheck });
        expect(hint, String(imageCheck)).toContain(
          "FIRST, before the retag, unless infra-cms:rollback knows poll guest access",
        );
        expect(hint).toContain(
          "skip the removal and its rerun below only if this prints 1 or more",
        );
        expect(hint).toContain(IMAGE_CHECK.replace(" -q ", " -c "));
        expectInOrder(hint, ["FIRST, before the retag", ...FULL_SEQUENCE]);
      }
    },
  );

  it.skipIf(!HAS_BASH)("prints it when the image check times out", () => {
    const { stdout, stderr } = rollbackHintRun(STRAPI_CMD, { imageCheck: 0, hang: ["run"] });
    expect(stdout).not.toContain("docker run");
    expect(stderr).toContain(
      "FIRST, before the retag, unless infra-cms:rollback knows poll guest access",
    );
    expectInOrder(stderr, FULL_SEQUENCE);
  });

  it.skipIf(!HAS_BASH)(
    "says nothing about it when the :rollback cms knows guest access (the row is its own grant)",
    () => {
      const { stdout, stderr } = rollbackHintRun(STRAPI_CMD, { imageCheck: 0 });
      expect(stdout).toContain(`bounded ${IMAGE_CHECK}`);
      expect(stderr).not.toContain("FIRST");
      expect(stderr).not.toContain("stop cms");
      expect(stderr).not.toContain(REVOKE_SQL);
      expect(stderr).not.toContain("THEN, once the previous cms is up");
      expect(stderr).toContain(`${COMPOSE_LINE} up -d --no-build web cms`);
    },
  );

  it.skipIf(!HAS_BASH)(
    "keeps the rerun after every start command, the direct start included",
    () => {
      const hint = rollbackHint('["pnpm","start"]', "3", { imageCheck: 1 });
      expectInOrder(hint, [
        `${COMPOSE_LINE} stop cms`,
        REVOKE_LINE,
        "To roll back to ",
        `${COMPOSE_LINE} -f /srv/infra/docker-compose.cms-legacy-tz.yml up -d --no-build web cms`,
        `${COMPOSE_LINE} -f /srv/infra/docker-compose.cms-legacy-tz.yml -f /tmp/cms-direct-start.yml up -d --no-build web cms`,
        "THEN, once the previous cms is up",
        REVOKE_LINE,
      ]);
    },
  );

  it.skipIf(!HAS_BASH)(
    "prints a removal command that the shell splits into the psql call of DEPLOYMENT",
    () => {
      const hint = rollbackHint(STRAPI_CMD, "0", { imageCheck: 1 });
      const lines = hint
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes(" exec -T db "));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe(lines[0]);
      const line = lines[0];
      const redirect = ` < /srv/${REVOKE_SQL}`;
      expect(line.endsWith(redirect)).toBe(true);
      // Run as printed (minus the redirect) with docker printing one argument per line.
      const run = runBash(`docker() { printf '%s\n' "$@"; }\n${line.slice(0, -redirect.length)}\n`);
      expect(run.status).toBe(0);
      expect(run.stdout.trimEnd().split("\n").slice(-4)).toEqual(["db", "sh", "-c", PSQL]);
    },
  );
});

describe(
  "rollback hint: bounded probes (a failed deploy must print every line)",
  BASH_BUDGET,
  () => {
    const COMPOSE_LINE =
      "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";

    it("bounds every docker call of the hint with timeout, and the naive query with lock and statement timeouts", () => {
      expect(shellLine("PROBE_TIMEOUT=(")).toBe("PROBE_TIMEOUT=(timeout -k 5 15)");
      const naive = shellFunction("naive_app_columns");
      expect(naive).toContain("SET lock_timeout = '5s';");
      expect(naive).toContain("SET statement_timeout = '10s';");
      // -q keeps the SET command tags out of the number the callers parse.
      expect(naive).toContain("psql -X -q -tA");
      // The preflight gate keeps its unbounded call; the hint passes the bound.
      expect(shellFunction("datetime_repair_env_missing")).toContain(
        'naive="$(naive_app_columns)"',
      );
      expect(shellFunction("print_rollback_hint")).toContain(
        'naive_app_columns "${PROBE_TIMEOUT[@]}"',
      );
    });

    it.skipIf(!HAS_BASH)("runs each of its docker calls under the bound", () => {
      for (const imageCheck of [0, 1]) {
        const { stdout } = rollbackHintRun('["pnpm","start"]', { imageCheck });
        const calls = stdout.split("\n").filter((l) => l.includes("docker "));
        expect(calls.map((l) => l.split(" ").slice(0, 3).join(" ")).sort()).toEqual([
          "bounded docker exec",
          "bounded docker image",
          "bounded docker image",
          "bounded docker run",
        ]);
        expect(stdout).toContain(
          `bounded docker image inspect -f {{ index .Config.Labels "org.sinnlos.datetime" }} infra-web:rollback`,
        );
        expect(stdout).not.toContain("UNBOUNDED");
      }
    });

    it.skipIf(!HAS_BASH)(
      "prints every line, the safe variant each, when all probes time out",
      () => {
        const { stderr } = rollbackHintRun('["pnpm","start"]', { hang: ["exec", "image", "run"] });
        expectInOrder(stderr, [
          "FIRST, before the retag, unless infra-cms:rollback knows poll guest access",
          `${COMPOSE_LINE} stop cms`,
          "rollback/revoke-guest-poll-vote.sql",
          "To roll back to ",
          "(the database could not be asked whether the datetime repair has run",
          "add -f /srv/infra/docker-compose.cms-legacy-tz.yml before up",
          "(infra-web:rollback could not be checked for the web's datetime port, so the web",
          `${COMPOSE_LINE} -f /srv/infra/docker-compose.web-legacy-tz.yml up -d --no-build web cms`,
          "(--no-build is essential",
          "Check the rollback image:",
          "docker image inspect -f '{{json .Config.Cmd}}' infra-cms:rollback",
          "THEN, once the previous cms is up",
          "rollback/revoke-guest-poll-vote.sql",
          "tags whatever runs then as :rollback",
        ]);
      },
    );

    it.skipIf(!HAS_BASH)(
      "says so when the database cannot be asked about the datetime repair",
      () => {
        const hint = rollbackHint('["node_modules/.bin/strapi","start"]', "");
        expect(hint).toContain(
          "the database could not be asked whether the datetime repair has run",
        );
        expect(hint).toContain(`${COMPOSE_LINE} up -d --no-build web cms`);
        expect(rollbackHint('["node_modules/.bin/strapi","start"]', "0")).not.toContain(
          "could not be asked",
        );
      },
    );
  },
);

describe(
  "datetime phase 2: the web in UTC, and the web legacy-zone override for a rollback",
  BASH_BUDGET,
  () => {
    const COMPOSE_LINE =
      "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";
    const WEB_OVERRIDE = "/srv/infra/docker-compose.web-legacy-tz.yml";
    const OVERRIDE = read("infra", "docker-compose.web-legacy-tz.yml");
    const STRAPI_CMD = '["node_modules/.bin/strapi","start"]';

    /** The environment lines of one compose service (two-space service indent). */
    function serviceEnvironment(compose: string, service: string): string[] {
      const lines = compose.split("\n");
      const start = lines.indexOf(`  ${service}:`);
      expect(start, service).toBeGreaterThanOrEqual(0);
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
      return (end === -1 ? rest : rest.slice(0, end)).filter(
        (line) => !line.trim().startsWith("#"),
      );
    }

    it("runs the web in UTC: the image and compose both say so", () => {
      expect(WEB_DOCKERFILE).toMatch(/^ENV TZ=UTC$/m);
      expect(serviceEnvironment(COMPOSE, "web")).toContain("      TZ: UTC");
      expect(serviceEnvironment(COMPOSE, "web")).toContain(
        "      APP_TIME_ZONE: ${APP_TIME_ZONE:-Europe/Berlin}",
      );
    });

    it("labels the web image with the value the rollback hint checks", () => {
      const label = shellAssignment("WEB_DATETIME_LABEL");
      const value = shellAssignment("WEB_DATETIME_VALUE");
      expect(WEB_DOCKERFILE).toContain(`LABEL ${label}="${value}"`);
      expect(shellFunction("image_web_zone_explicit")).toContain(
        'docker image inspect -f "{{ index .Config.Labels \\"${WEB_DATETIME_LABEL}\\" }}" "$1"',
      );
    });

    it("the override gives the web exactly the TZ the compose file set before the port, and nothing else", () => {
      const lines = OVERRIDE.split("\n").filter(
        (line) => line.trim() !== "" && !line.trim().startsWith("#"),
      );
      expect(lines).toEqual([
        "services:",
        "  web:",
        "    environment:",
        "      TZ: ${APP_TIME_ZONE:-Europe/Berlin}",
      ]);
      // The web's APP_TIME_ZONE default, so the old start check (Node runs in APP_TIME_ZONE) passes.
      expect(serviceEnvironment(COMPOSE, "web")).toContain(
        "      APP_TIME_ZONE: ${APP_TIME_ZONE:-Europe/Berlin}",
      );
      expect(shellAssignment("COMPOSE_WEB_LEGACY_TZ")).toBe(
        "${INFRA_DIR}/docker-compose.web-legacy-tz.yml",
      );
    });

    it.skipIf(!HAS_BASH)("adds the override for a :rollback web from before the port", () => {
      const hint = rollbackHint(STRAPI_CMD, "0", { webLabel: "<no value>" });
      expectInOrder(hint, [
        "To roll back to ",
        "(infra-web:rollback predates the web's datetime port: it renders dates in its process",
        // Both kinds of old web: one with the start check (500), one without (UTC times).
        "zone, so in UTC it fails to start or shows UTC times; hence the web override",
        `${COMPOSE_LINE} -f ${WEB_OVERRIDE} up -d --no-build web cms`,
      ]);
      expect(hint).not.toContain("could not be checked for the web's datetime port");
    });

    it.skipIf(!HAS_BASH)(
      "adds it, with the check, when the :rollback web cannot be checked",
      () => {
        for (const probes of [{ webLabel: null }, { hang: ["image"] }]) {
          const hint = rollbackHint(STRAPI_CMD, "0", probes);
          expect(hint).toContain(
            "(infra-web:rollback could not be checked for the web's datetime port, so the web",
          );
          expect(hint).toContain(
            "in UTC a web from before it fails to start or shows UTC times, a newer one only",
          );
          expect(hint).toContain(
            `docker image inspect -f '{{ index .Config.Labels "org.sinnlos.datetime" }}' infra-web:rollback`,
          );
          expect(hint).toContain(`${COMPOSE_LINE} -f ${WEB_OVERRIDE} up -d --no-build web cms`);
        }
      },
    );

    it.skipIf(!HAS_BASH)("leaves it out for a :rollback web from the port on", () => {
      const hint = rollbackHint(STRAPI_CMD, "0", { webLabel: "zone-explicit" });
      expect(hint).toContain(`${COMPOSE_LINE} up -d --no-build web cms`);
      expect(hint).not.toContain("web-legacy-tz");
    });

    it.skipIf(!HAS_BASH)(
      "puts both overrides and the direct start on the same up line when all are needed",
      () => {
        const hint = rollbackHint('["pnpm","start"]', "3", { webLabel: "<no value>" });
        expect(hint).toContain(
          `${COMPOSE_LINE} -f /srv/infra/docker-compose.cms-legacy-tz.yml -f ${WEB_OVERRIDE} up -d --no-build web cms`,
        );
        expect(hint).toContain(
          `${COMPOSE_LINE} -f /srv/infra/docker-compose.cms-legacy-tz.yml -f ${WEB_OVERRIDE} -f /tmp/cms-direct-start.yml up -d --no-build web cms`,
        );
      },
    );
  },
);

/**
 * The preflight of deploy.sh from its scan to "Preflight OK", in bash, with
 * compose answering `env` (the cms service) and the docker probes (JWT
 * rotation, datetime repair) stubbed to "nothing to do".
 */
function preflightRun(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const from = DEPLOY.indexOf('findings="$(');
  const okLine = 'log "Preflight OK"';
  const to = DEPLOY.indexOf(okLine, from) + okLine.length;
  const script = [
    "set -euo pipefail",
    "log() { printf '==> %s\\n' \"$*\"; }",
    "jwt_rotation_missing() { return 1; }",
    "datetime_repair_env_missing() { return 1; }",
    "compose_stub() {",
    "cat <<'COMPOSE_JSON'",
    composeJson(env),
    "COMPOSE_JSON",
    "}",
    "COMPOSE=(compose_stub)",
    `PREFLIGHT_FATAL_KEYS=${shellQuote(shellAssignment("PREFLIGHT_FATAL_KEYS"))}`,
    `PREFLIGHT_WARN_KEYS=${shellQuote(shellAssignment("PREFLIGHT_WARN_KEYS"))}`,
    shellFunction("preflight_scan"),
    DEPLOY.slice(from, to),
    "",
  ].join("\n");
  return runBash(script);
}

describe("Entra preflight messages and exit code (D-ENTRA-01)", BASH_BUDGET, () => {
  const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  /** What compose hands the apps from an infra/.env without ENTRA_ENABLED. */
  const entraOff = (clientId: string, secret: string) => ({
    ENTRA_ENABLED: "0",
    MS_TENANT_ID: "11111111-2222-4333-8444-555555555555",
    MS_CLIENT_ID: clientId,
    AUTH_MICROSOFT_ENTRA_ID_ID: clientId,
    AUTH_MICROSOFT_ENTRA_ID_SECRET: secret,
  });

  it.skipIf(!HAS_BASH)("warns, and passes, when a real app registration goes off", () => {
    const run = preflightRun(entraOff(CLIENT, "client-secret-value"));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Preflight OK");
    expect(run.stderr).toContain(
      "WARNING: infra/.env holds a Microsoft app registration (MS_CLIENT_ID is a GUID and",
    );
    expect(run.stderr).toContain("it is OFF after this deploy");
    expect(run.stderr).toContain('"Upgrading to the Entra sign-in (batch 9, lane 4A)"');
    expect(run.stderr).not.toContain("stays off");
    expect(run.stderr).not.toContain("client-secret-value");
  });

  it.skipIf(!HAS_BASH)("only notes template values, and passes", () => {
    const run = preflightRun(entraOff("your-app-client-id", "your-app-client-secret"));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Preflight OK");
    expect(run.stderr).toContain(
      "NOTE: MS_CLIENT_ID/MS_CLIENT_SECRET are set in infra/.env, but ENTRA_ENABLED is not 1:",
    );
    expect(run.stderr).not.toContain("WARNING");
  });

  it.skipIf(!HAS_BASH)("says nothing about Entra without MS_* values", () => {
    const run = preflightRun(entraOff("", ""));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
  });
});

describe("rollback hint: the target of the last-known-good state (FX35)", BASH_BUDGET, () => {
  const COMPOSE_LINE =
    "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";
  const SHA = "5be7dc7a1b2c";
  const STRAPI_CMD = '["node_modules/.bin/strapi","start"]';

  it.skipIf(!HAS_BASH)("retags the SHA images of the state, never :rollback", () => {
    const { stdout, stderr } = rollbackHintRun(STRAPI_CMD, { ref: SHA });
    expectInOrder(stderr, [
      `To roll back to the last-known-good deploy ${SHA} (2026-09-29T10:00:00+02:00), retag, then start without a build:`,
      `docker tag infra-web:${SHA} infra-web:latest`,
      `docker tag infra-cms:${SHA} infra-cms:latest`,
      `${COMPOSE_LINE} up -d --no-build web cms`,
      `Rollback target: the last-known-good state (${STATE_FILE_STUB}); a re-run of this`,
    ]);
    expect(stderr).not.toContain(":rollback");
    // Every probe looks at the target's images.
    expect(stdout).toContain(
      `bounded docker image inspect -f {{json .Config.Cmd}} infra-cms:${SHA}`,
    );
    expect(stdout).toContain(
      `bounded docker image inspect -f {{ index .Config.Labels "org.sinnlos.datetime" }} infra-web:${SHA}`,
    );
    expect(stdout).toContain(`--entrypoint grep infra-cms:${SHA} -q visibleToGuests`);
    expect(stdout).not.toContain(":rollback");
  });

  it.skipIf(!HAS_BASH)("keeps every special case for a SHA target", () => {
    const hint = rollbackHint('["pnpm","start"]', "2", {
      ref: SHA,
      imageCheck: 1,
      webLabel: "<no value>",
    });
    expectInOrder(hint, [
      `FIRST, before the retag: infra-cms:${SHA} predates poll guest access.`,
      `${COMPOSE_LINE} stop cms`,
      "rollback/revoke-guest-poll-vote.sql",
      `docker tag infra-web:${SHA} infra-web:latest`,
      `(infra-web:${SHA} predates the web's datetime port`,
      `${COMPOSE_LINE} -f /srv/infra/docker-compose.cms-legacy-tz.yml -f /srv/infra/docker-compose.web-legacy-tz.yml up -d --no-build web cms`,
      `infra-cms:${SHA} starts with pnpm (Cmd ["pnpm","start"])`,
      `${COMPOSE_LINE} -f /srv/infra/docker-compose.cms-legacy-tz.yml -f /srv/infra/docker-compose.web-legacy-tz.yml -f /tmp/cms-direct-start.yml up -d --no-build web cms`,
      "THEN, once the previous cms is up",
      "rollback/revoke-guest-poll-vote.sql",
    ]);
  });

  it.skipIf(!HAS_BASH)("says there is nothing to roll back to on a fresh install", () => {
    const { stdout, stderr } = rollbackHintRun(STRAPI_CMD, { ref: "" });
    expect(stderr).toContain("There is no earlier release on this host to roll back to");
    expect(stderr).not.toContain("docker tag");
    expect(stdout).not.toContain("docker ");
  });
});

describe(
  "live-smoke switches come from compose, as the apps read them (B05, FX35)",
  BASH_BUDGET,
  () => {
    /** live_smoke_mode of deploy.sh with compose answering `env` and PASSWORDS_FILE readable or not. */
    function liveSmokeMode(
      env: Record<string, string>,
      opts: { passwords?: boolean; smokeEnv?: boolean } = {},
    ) {
      const script = [
        "set -euo pipefail",
        "compose_stub() {",
        "cat <<'COMPOSE_JSON'",
        composeJson(env),
        "COMPOSE_JSON",
        "}",
        "COMPOSE=(compose_stub)",
        'T="$(mktemp -d)"',
        "trap 'rm -rf \"$T\"' EXIT",
        opts.passwords ? 'echo "casey.jones@sinnlos.local pw" > "$T/pw"' : "",
        'PASSWORDS_FILE="$T/pw"',
        opts.smokeEnv
          ? "export SMOKE_PASSWORD=a SMOKE_AUTHOR_PASSWORD=b"
          : "unset SMOKE_PASSWORD SMOKE_AUTHOR_PASSWORD",
        shellFunction("compose_env_value"),
        shellFunction("live_smoke_mode"),
        "live_smoke_mode",
        "",
      ].join("\n");
      const res = runBash(script);
      expect(res.status, res.stderr).toBe(0);
      return res.stdout.trim();
    }

    it("reads LIVE_EVENTS_DISABLED from compose, not from the shell", () => {
      expect(DEPLOY).not.toMatch(/\$\{LIVE_EVENTS_DISABLED/);
      expect(shellFunction("live_smoke_mode")).toContain("compose_env_value LIVE_EVENTS_DISABLED");
    });

    it.skipIf(!HAS_BASH)(
      "skips it only for LIVE_EVENTS_DISABLED exactly 1 (the apps' rule)",
      () => {
        expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "1" }, { passwords: true })).toMatch(
          /^skip: LIVE_EVENTS_DISABLED=1/,
        );
        for (const value of ["0", "", "true"]) {
          expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: value }, { passwords: true }), value).toBe(
            "run",
          );
        }
      },
    );

    it.skipIf(!HAS_BASH)("runs it on an Entra-only instance without the credentials file", () => {
      expect(
        liveSmokeMode({ LIVE_EVENTS_DISABLED: "0", ENTRA_ENABLED: "1", AUTH_LOCAL_ENABLED: "0" }),
      ).toMatch(/^run \(Entra-only/);
      // With local sign-in next to Entra the demo accounts sign in as usual.
      expect(
        liveSmokeMode({ LIVE_EVENTS_DISABLED: "0", ENTRA_ENABLED: "1", AUTH_LOCAL_ENABLED: "1" }),
      ).toMatch(/^skip: demo credentials file .* not readable/);
    });

    it.skipIf(!HAS_BASH)("needs the credentials file, or both passwords in the environment", () => {
      expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "0" })).toMatch(/^skip: demo credentials file/);
      expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "0" }, { passwords: true })).toBe("run");
      expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "0" }, { smokeEnv: true })).toBe("run");
    });
  },
);
