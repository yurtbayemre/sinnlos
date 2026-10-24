import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digestsEnabled } from "../digest/send-digests";
import { EntraConfigError, parseEntraConfig } from "../entra/config";
import { OidcConfigError, parseOidcConfig } from "../oidc/config";
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
 *   3. compose_env_value undoes Go's JSON escaping, so the values it reads
 *      (live-smoke's switches) compare as the apps read them,
 *   4. the Entra preflight (D-ENTRA-01) refuses exactly the settings the
 *      cms (entra/config.ts parseEntraConfig) and the web refuse to start
 *      with when ENTRA_ENABLED=1, is fatal, and without it only notes stale
 *      MS_* keys, with exit code 0; compose hands both apps the keys they
 *      read,
 *   5. the rollback hint of a failed deploy (upgrade floor v0.25, v0.29)
 *      prints the retag commands only for a target whose images trace to
 *      the v0.25.0 commit or a later one in the checkout's full history
 *      (their revision label, or the state's SHA for the recorded image
 *      ids), names the target (the SHA tag of the last-known-good state,
 *      :rollback without one, nothing on a fresh install), bounds every
 *      docker call, and otherwise only says where to check it by hand,
 *   6. B05: the preflight reads DIGESTS_DISABLED like the cms
 *      (parseEnvFlag: 1/true/yes/on, trimmed, any case), and live-smoke's
 *      switches come from the env compose hands the apps
 *      (LIVE_EVENTS_DISABLED, the identity-provider-only case), not from
 *      the shell;
 *   7. batch 16 (DA03): the preflight refuses wiki revision draft rows
 *      while this release runs wiki revisions without draft & publish, with
 *      a bounded probe, naming infra/migrations/wiki-revision-dp/.
 * The state, tag and lock logic of FX35 (and a full stubbed deploy) is
 * pinned in infra/deploy-flow.test.ts.
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

  it.skipIf(!HAS_AWK)("notes every MS_* value left without ENTRA_ENABLED=1 (entra-inert)", () => {
    const scan = (env: Record<string, string>) =>
      runAwk(PREFLIGHT_AWK, { fatal_keys: "", warn_keys: "" }, composeJson(composeEnv(env)));
    const registration = {
      MS_TENANT_ID: TENANT,
      MS_CLIENT_ID: CLIENT,
      MS_CLIENT_SECRET: "s3cr3t",
    };
    for (const env of [
      ...["0", "", "true"].map((flag) => ({ ...registration, ENTRA_ENABLED: flag })),
      { ...registration, MS_CLIENT_ID: "your-app-client-id" },
      { ...registration, MS_CLIENT_SECRET: "" },
      { MS_CLIENT_SECRET: "s3cr3t" },
    ]) {
      expect(scan(env), JSON.stringify(env)).toEqual(["entra-inert MS_CLIENT_ID"]);
    }
    // With ENTRA_ENABLED=1 the same registration is a valid configuration.
    expect(scan({ ...registration, ENTRA_ENABLED: "1", ENTRA_EXCHANGE_SECRET: SECRET })).toEqual(
      [],
    );
  });

  it("makes an invalid Entra configuration fatal and stale MS_* keys a note, in the preflight", () => {
    const invalidGate = 'if [[ -n "${entra_invalid_keys}" ]]; then';
    const inertGate = 'if [[ -n "${entra_inert_keys}" ]]; then';
    const fatal = DEPLOY.slice(DEPLOY.indexOf(invalidGate));
    expect(fatal.slice(0, fatal.indexOf("\nfi\n"))).toContain("preflight_failed=1");
    for (const gate of [inertGate]) {
      const block = DEPLOY.slice(DEPLOY.indexOf(gate));
      expect(block.slice(0, block.indexOf("\nfi\n")), gate).not.toContain("preflight_failed");
    }
    for (const gate of [invalidGate, inertGate]) {
      expect(DEPLOY.indexOf(gate), gate).toBeGreaterThan(-1);
      expect(DEPLOY.indexOf(gate), gate).toBeLessThan(DEPLOY.indexOf('log "Preflight OK"'));
    }
    // The old "Microsoft sign-in cannot complete" refusal and the pre-D-ENTRA-01 warning are gone.
    expect(DEPLOY).not.toContain("entra_template_keys");
    expect(DEPLOY).not.toContain("entra-was-on");
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

describe("OIDC preflight (v0.25.0)", () => {
  const SECRET = "0123456789abcdef0123456789abcdef";

  /** The cms and web env compose builds from one infra/.env (the OIDC keys, compose defaults). */
  function composeEnv(env: Record<string, string>): Record<string, string> {
    return {
      ENTRA_ENABLED: env.ENTRA_ENABLED ?? "0",
      OIDC_ENABLED: env.OIDC_ENABLED ?? "0",
      OIDC_ISSUER: env.OIDC_ISSUER ?? "",
      OIDC_CLIENT_ID: env.OIDC_CLIENT_ID ?? "",
      OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET ?? "",
      OIDC_EXCHANGE_SECRET: env.OIDC_EXCHANGE_SECRET ?? "",
      OIDC_SCOPE: env.OIDC_SCOPE ?? "openid profile email",
      OIDC_DISPLAY_NAME: env.OIDC_DISPLAY_NAME ?? "Single Sign-On",
      OIDC_ROLES_CLAIM: env.OIDC_ROLES_CLAIM ?? "roles",
      OIDC_DEPARTMENT_CLAIM: env.OIDC_DEPARTMENT_CLAIM ?? "",
      OIDC_ZITADEL_ORG_ID: env.OIDC_ZITADEL_ORG_ID ?? "",
      OIDC_DEFAULT_ROLE: env.OIDC_DEFAULT_ROLE ?? "deny",
      OIDC_SESSION_TTL: env.OIDC_SESSION_TTL ?? "12h",
      OIDC_ALLOW_HTTP: env.OIDC_ALLOW_HTTP ?? "0",
    };
  }

  const valid = {
    OIDC_ENABLED: "1",
    OIDC_ISSUER: "https://sso.example.com/realms/sinnlos",
    OIDC_CLIENT_ID: "sinnlos-web",
    OIDC_CLIENT_SECRET: "client-secret-value",
    OIDC_EXCHANGE_SECRET: SECRET,
  };
  const zitadel = {
    ...valid,
    OIDC_ISSUER: "https://sinnlos-abc123.zitadel.cloud",
    OIDC_ROLES_CLAIM: "urn:zitadel:iam:org:project:roles",
    OIDC_ZITADEL_ORG_ID: "396173383835910147",
  };

  // The contract's rules (deep-dive plan-oidc.md "v0.25.0 build contract"):
  // env → the infra/.env keys the cms and the web refuse to start with.
  const CASES: [Record<string, string>, string[]][] = [
    [valid, []],
    [{ ...valid, OIDC_ISSUER: "https://auth.example.com/application/o/sinnlos/" }, []],
    [{ ...valid, OIDC_ISSUER: ` ${valid.OIDC_ISSUER} ` }, []],
    [zitadel, []],
    [{ ...zitadel, OIDC_DEPARTMENT_CLAIM: "urn:zitadel:iam:user:metadata.department" }, []],
    [{ ...valid, OIDC_ISSUER: "http://localhost:18080/realms/sinnlos" }, ["OIDC_ISSUER"]],
    [{ ...valid, OIDC_ISSUER: "http://localhost:18080/realms/sinnlos", OIDC_ALLOW_HTTP: "1" }, []],
    [
      { ...valid, OIDC_ISSUER: "http://localhost:18080/realms/sinnlos", OIDC_ALLOW_HTTP: "true" },
      ["OIDC_ISSUER"],
    ],
    [{ ...valid, OIDC_ISSUER: "" }, ["OIDC_ISSUER"]],
    [{ ...valid, OIDC_ISSUER: "sso.example.com/realms/sinnlos" }, ["OIDC_ISSUER"]],
    [{ ...valid, OIDC_ISSUER: "https://" }, ["OIDC_ISSUER"]],
    [{ ...valid, OIDC_ISSUER: "https://sso.example.com/realms/sin nlos" }, ["OIDC_ISSUER"]],
    [{ ...valid, OIDC_ISSUER: `https://sso.example.com/${"a".repeat(231)}` }, []],
    [{ ...valid, OIDC_ISSUER: `https://sso.example.com/${"a".repeat(232)}` }, ["OIDC_ISSUER"]],
    [{ ...valid, OIDC_CLIENT_ID: "" }, ["OIDC_CLIENT_ID"]],
    [{ ...valid, OIDC_CLIENT_ID: "   " }, ["OIDC_CLIENT_ID"]],
    [{ ...valid, OIDC_CLIENT_ID: "c".repeat(256) }, ["OIDC_CLIENT_ID"]],
    [{ ...valid, OIDC_CLIENT_SECRET: "" }, ["OIDC_CLIENT_SECRET"]],
    [{ ...valid, OIDC_EXCHANGE_SECRET: "x".repeat(31) }, ["OIDC_EXCHANGE_SECRET"]],
    [{ ...valid, OIDC_EXCHANGE_SECRET: ` ${"y".repeat(30)} ` }, ["OIDC_EXCHANGE_SECRET"]],
    [{ ...valid, OIDC_EXCHANGE_SECRET: `change-me-${"z".repeat(30)}` }, ["OIDC_EXCHANGE_SECRET"]],
    [{ ...valid, ENTRA_ENABLED: "1" }, ["ENTRA_ENABLED"]],
    [{ ...valid, OIDC_DEFAULT_ROLE: "member" }, []],
    [{ ...valid, OIDC_DEFAULT_ROLE: "guest" }, []],
    [{ ...valid, OIDC_DEFAULT_ROLE: "" }, []],
    [{ ...valid, OIDC_DEFAULT_ROLE: "editor" }, ["OIDC_DEFAULT_ROLE"]],
    [{ ...valid, OIDC_SESSION_TTL: "7d" }, []],
    [{ ...valid, OIDC_SESSION_TTL: "8d" }, ["OIDC_SESSION_TTL"]],
    [{ ...valid, OIDC_SESSION_TTL: "12" }, ["OIDC_SESSION_TTL"]],
    [{ ...zitadel, OIDC_ZITADEL_ORG_ID: "" }, ["OIDC_ZITADEL_ORG_ID"]],
    [{ ...valid, OIDC_ZITADEL_ORG_ID: "acme" }, ["OIDC_ZITADEL_ORG_ID"]],
    [{ ...valid, OIDC_ZITADEL_ORG_ID: "396173383835910147" }, []],
    [{ ...valid, OIDC_SCOPE: "openid" }, []],
    [{ ...valid, OIDC_SCOPE: "" }, []],
    [{ ...valid, OIDC_SCOPE: "profile email" }, ["OIDC_SCOPE"]],
    [{ ...valid, OIDC_SCOPE: "openidx profile" }, ["OIDC_SCOPE"]],
    [{ ...valid, OIDC_DISPLAY_NAME: "d".repeat(40) }, []],
    [{ ...valid, OIDC_DISPLAY_NAME: "d".repeat(41) }, ["OIDC_DISPLAY_NAME"]],
    [{ ...valid, OIDC_ROLES_CLAIM: "resource_access.sinnlos-web.roles" }, []],
    [{ ...valid, OIDC_ROLES_CLAIM: "roles..x" }, ["OIDC_ROLES_CLAIM"]],
    [{ ...valid, OIDC_ROLES_CLAIM: "my roles" }, ["OIDC_ROLES_CLAIM"]],
    [{ ...valid, OIDC_DEPARTMENT_CLAIM: "department" }, []],
    [{ ...valid, OIDC_DEPARTMENT_CLAIM: ".department" }, ["OIDC_DEPARTMENT_CLAIM"]],
    [
      { OIDC_ENABLED: "1" },
      ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_EXCHANGE_SECRET"],
    ],
  ];

  /**
   * What the cms (parseOidcConfig) and the web (its own half: client secret,
   * scope, button label; lib/auth-config.ts parseOidcWebConfig, same rules)
   * refuse, as infra/.env keys: the table above must be exactly that.
   */
  function refusedByTheApps(env: Record<string, string>): string[] {
    const composed = composeEnv(env);
    const keys: string[] = [];
    try {
      parseOidcConfig(composed);
    } catch (err) {
      if (!(err instanceof OidcConfigError)) throw err;
      keys.push(...err.issues.map((issue) => issue.variable));
    }
    if (composed.OIDC_ENABLED === "1") {
      if (composed.OIDC_CLIENT_SECRET.trim() === "") keys.push("OIDC_CLIENT_SECRET");
      const scope = composed.OIDC_SCOPE.trim();
      if (scope !== "" && !scope.split(/\s+/).includes("openid")) keys.push("OIDC_SCOPE");
      if (composed.OIDC_DISPLAY_NAME.trim().length > 40) keys.push("OIDC_DISPLAY_NAME");
    }
    return [...new Set(keys)];
  }

  it("the table is what the cms and the web refuse to start with", () => {
    for (const [env, keys] of CASES) {
      expect(sorted(refusedByTheApps(env)), JSON.stringify(env)).toEqual(sorted(keys));
    }
  });

  // The OIDC findings only (ENTRA_ENABLED=1 also brings the Entra block's own).
  const scan = (env: Record<string, string>) =>
    runAwk(PREFLIGHT_AWK, { fatal_keys: "", warn_keys: "" }, composeJson(composeEnv(env))).filter(
      (finding) => finding.startsWith("oidc-"),
    );

  it.skipIf(!HAS_AWK)(
    "refuses exactly the settings of the contract with OIDC_ENABLED=1",
    () => {
      for (const [env, keys] of CASES) {
        expect(sorted(scan(env)), JSON.stringify(env)).toEqual(
          sorted(keys.map((key) => `oidc-invalid ${key}`)),
        );
      }
    },
    30_000,
  );

  it.skipIf(!HAS_AWK)("ignores every OIDC_* value unless OIDC_ENABLED is exactly 1", () => {
    const stale = { OIDC_ISSUER: "http://x", OIDC_EXCHANGE_SECRET: "short", ENTRA_ENABLED: "1" };
    for (const flag of ["0", "", "true", "yes", " 1"]) {
      expect(scan({ ...stale, OIDC_ENABLED: flag }), flag).toEqual([]);
    }
  });

  it("makes an invalid OIDC configuration fatal, in the preflight", () => {
    const gate = 'if [[ -n "${oidc_invalid_keys}" ]]; then';
    const block = DEPLOY.slice(DEPLOY.indexOf(gate));
    expect(DEPLOY.indexOf(gate)).toBeGreaterThan(-1);
    expect(block.slice(0, block.indexOf("\nfi\n"))).toContain("preflight_failed=1");
    expect(DEPLOY.indexOf(gate)).toBeLessThan(DEPLOY.indexOf('log "Preflight OK"'));
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
      "OIDC_ENABLED: ${OIDC_ENABLED:-0}",
      "OIDC_ISSUER: ${OIDC_ISSUER:-}",
      "OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:-}",
      "OIDC_EXCHANGE_SECRET: ${OIDC_EXCHANGE_SECRET:-}",
      "OIDC_ZITADEL_ORG_ID: ${OIDC_ZITADEL_ORG_ID:-}",
      "OIDC_ALLOW_HTTP: ${OIDC_ALLOW_HTTP:-0}",
    ]) {
      expect(cms, line).toContain(line);
      expect(web, line).toContain(line);
    }
    for (const line of [
      "OIDC_ROLES_CLAIM: ${OIDC_ROLES_CLAIM:-roles}",
      "OIDC_DEPARTMENT_CLAIM: ${OIDC_DEPARTMENT_CLAIM:-}",
      "OIDC_DEFAULT_ROLE: ${OIDC_DEFAULT_ROLE:-deny}",
      "OIDC_SESSION_TTL: ${OIDC_SESSION_TTL:-12h}",
    ]) {
      expect(cms, line).toContain(line);
    }
    for (const line of [
      "OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:-}",
      "OIDC_SCOPE: ${OIDC_SCOPE:-openid profile email}",
      "OIDC_DISPLAY_NAME: ${OIDC_DISPLAY_NAME:-Single Sign-On}",
    ]) {
      expect(web, line).toContain(line);
    }
    // The cms verifies the token itself and never needs the client secret.
    expect(cms).not.toContain("OIDC_CLIENT_SECRET");
  });
});

describe("Meilisearch preflight (v0.21)", () => {
  const MASTER = "93c0a2576c0bab96c0cfe2dc8f969cdd";
  const KEY = "5f0e1c2d3b4a59687766554433221100ffeeddccbbaa99887766554433221100";
  /**
   * What compose renders from infra/.env: MEILI_MASTER_KEY only while the
   * search profile is on (the meili service), the MEILISEARCH_* keys always.
   */
  const rendered = (env: { profile?: boolean } & Record<string, string | boolean>) => {
    const { profile, ...keys } = env;
    return {
      MEILISEARCH_ENABLED: "0",
      MEILISEARCH_URL: "http://sinnlos-meili:7700",
      MEILISEARCH_WRITE_KEY: "",
      MEILISEARCH_SEARCH_KEY: "",
      ...(profile ? { MEILI_MASTER_KEY: "" } : {}),
      ...(keys as Record<string, string>),
    };
  };
  const scan = (env: { profile?: boolean } & Record<string, string | boolean>) =>
    runAwk(PREFLIGHT_AWK, { fatal_keys: "", warn_keys: "" }, composeJson(rendered(env)));
  const on = {
    profile: true,
    MEILI_MASTER_KEY: MASTER,
    MEILISEARCH_ENABLED: "1",
    MEILISEARCH_WRITE_KEY: KEY,
    MEILISEARCH_SEARCH_KEY: KEY,
  };

  it.skipIf(!HAS_AWK)("says nothing while the module is off, with or without the profile", () => {
    expect(scan({})).toEqual([]);
    expect(scan({ profile: true, MEILI_MASTER_KEY: MASTER })).toEqual([]);
    // On at exactly "1", as the apps read it.
    for (const flag of ["0", "", "true", "yes", " 1"]) {
      expect(scan({ MEILISEARCH_ENABLED: flag }), flag).toEqual([]);
    }
    expect(scan(on)).toEqual([]);
  });

  it.skipIf(!HAS_AWK)("refuses a master key the meili container would not start with", () => {
    for (const master of [
      "",
      "   ",
      "0123456789abcde",
      "change-me-meili-master-key",
      "<openssl rand -hex 32>",
    ]) {
      expect(scan({ profile: true, MEILI_MASTER_KEY: master }), master).toEqual([
        "meili-invalid MEILI_MASTER_KEY",
      ]);
    }
  });

  it.skipIf(!HAS_AWK)("refuses MEILISEARCH_ENABLED=1 without the profile or a key", () => {
    expect(scan({ MEILISEARCH_ENABLED: "1" })).toEqual([
      "meili-invalid COMPOSE_PROFILES",
      "meili-invalid MEILISEARCH_WRITE_KEY",
      "meili-invalid MEILISEARCH_SEARCH_KEY",
    ]);
    // Profile off: compose renders no MEILI_MASTER_KEY at all.
    const { MEILI_MASTER_KEY: _master, ...profileOff } = on;
    expect(scan({ ...profileOff, profile: false })).toEqual(["meili-invalid COMPOSE_PROFILES"]);
    expect(scan({ ...on, MEILISEARCH_URL: " " })).toEqual(["meili-invalid MEILISEARCH_URL"]);
    expect(scan({ ...on, MEILISEARCH_WRITE_KEY: "change-me" })).toEqual([
      "meili-invalid MEILISEARCH_WRITE_KEY",
    ]);
    expect(scan({ ...on, MEILISEARCH_SEARCH_KEY: "" })).toEqual([
      "meili-invalid MEILISEARCH_SEARCH_KEY",
    ]);
  });

  it("wires the keys as the apps read them, the master key only into the meili service", () => {
    const service = (name: string) => {
      const start = COMPOSE.indexOf(`\n  ${name}:\n`);
      const next = COMPOSE.slice(start + 1).search(/\n {2}[a-z]+:\n/);
      // Without comments: the meili service's comment sits above it, at the end of web's block.
      return COMPOSE.slice(start, next < 0 ? undefined : start + 1 + next)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
    };
    const [cms, web, meili] = [service("cms"), service("web"), service("meili")];
    for (const block of [cms, web]) {
      expect(block).toContain("MEILISEARCH_ENABLED: ${MEILISEARCH_ENABLED:-0}");
      expect(block).toContain("MEILISEARCH_URL: ${MEILISEARCH_URL:-http://sinnlos-meili:7700}");
      expect(block).not.toContain("MEILI_MASTER_KEY");
    }
    expect(cms).toContain("MEILISEARCH_WRITE_KEY: ${MEILISEARCH_WRITE_KEY:-}");
    expect(cms).not.toContain("MEILISEARCH_SEARCH_KEY");
    expect(web).toContain("MEILISEARCH_SEARCH_KEY: ${MEILISEARCH_SEARCH_KEY:-}");
    expect(web).not.toContain("MEILISEARCH_WRITE_KEY");
    expect(meili).toContain('profiles: ["search"]');
    expect(meili).toContain("MEILI_MASTER_KEY: ${MEILI_MASTER_KEY:-}");
    expect(meili).toContain("MEILI_ENV: production");
    expect(meili).toMatch(/image: getmeili\/meilisearch:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\n/);
    // cms and web start without it: their search falls back.
    for (const block of [cms, web]) expect(block).not.toMatch(/^\s+(- )?meili:?$/m);
  });
});

describe("web image labels for deploy.sh before v0.29", () => {
  it("keeps the two labels an older checkout's deploy.sh reads (JWT gate, rollback hint)", () => {
    // Without the first, a deploy.sh before v0.29 would demand a JWT_SECRET
    // rotation when this web runs; without the second, its rollback hint
    // would add a legacy-zone override for it.
    expect(WEB_DOCKERFILE).toContain('LABEL org.sinnlos.strapi-jwt="server-only"');
    expect(WEB_DOCKERFILE).toContain('LABEL org.sinnlos.datetime="zone-explicit"');
  });
});

describe("compose_env_value", () => {
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

/** What the rollback hint's probes see (docker and git stubbed). */
interface HintProbes {
  /**
   * The rollback target (ROLLBACK_REF): a 12-digit SHA tag of the
   * last-known-good state (default), "rollback" (the images this run tagged
   * without a state), or "" (nothing to roll back to).
   */
  ref?: string;
  /** The images' org.opencontainers.image.revision labels ("" = none). */
  webLabel?: string;
  cmsLabel?: string;
  /** The images' ids; null = the image does not exist here. */
  webId?: string | null;
  cmsId?: string | null;
  /** The state's SHA and image ids (only read for a SHA target). */
  stateSha?: string;
  stateWebImage?: string;
  stateCmsImage?: string;
  /** Commits the checkout knows: abbreviation or full SHA -> full SHA. */
  known?: Record<string, string>;
  /** Full SHAs at or after the floor commit (merge-base --is-ancestor). */
  afterFloor?: string[];
  /** What `git rev-parse --is-shallow-repository` prints. */
  shallow?: string;
  /** Every docker call hangs (the `timeout` stub ends it with 124). */
  hang?: boolean;
}

/** The state file the hint names for a SHA target (harness value). */
const STATE_FILE_STUB = "/srv/.git/sinnlos-deploy/infra.state";
/** The bootstrap marker the hint names for a :rollback target (harness value). */
const BOOTSTRAP_FILE_STUB = "/srv/.git/sinnlos-deploy/infra.bootstrap";
const HINT_COMPOSE_LINE =
  "docker compose -p infra -f /srv/infra/docker-compose.yml -f /srv/infra/docker-compose.traefik.yml";
const RELEASE = "aa4162b4571bd1c6e0c4f9a7d2b3c4d5e6f70809";
const RELEASE_TAG = RELEASE.slice(0, 12);
const V025 = "0c26656e98f930d6298ae5ee3b3234ba7fdc780f";
const OLD = "5be7dc7a1b2c3d4e5f60718293a4b5c6d7e8f901";

/**
 * print_rollback_hint with docker, `timeout` and git stubbed and the real
 * image_field and rollback_target_commit of deploy.sh. The docker stub logs
 * every call to stdout (fd 3) as "bounded docker …" when it runs under the
 * `timeout` stub and "UNBOUNDED docker …" otherwise.
 */
function rollbackHintRun(probes: HintProbes = {}): { stdout: string; stderr: string } {
  const ref = probes.ref ?? RELEASE_TAG;
  const known = probes.known ?? {
    [RELEASE]: RELEASE,
    [RELEASE_TAG]: RELEASE,
    [V025]: V025,
    [OLD]: OLD,
  };
  const knownCases = Object.entries(known)
    .map(([key, full]) => `    ${shellQuote(`${key}^{commit}`)}) echo ${full} ;;`)
    .join("\n");
  const script = [
    "set -euo pipefail",
    "exec 3>&1",
    "PROJECT=infra",
    `COMPOSE=(${HINT_COMPOSE_LINE})`,
    `ROLLBACK_REF=${shellQuote(ref)}`,
    `ROLLBACK_ORIGIN=${shellQuote(ref === "rollback" ? "the images that ran before this deploy (:rollback)" : ref ? `the last-known-good deploy ${ref} (2026-10-23T18:06:00+02:00)` : "")}`,
    `STATE_FILE=${STATE_FILE_STUB}`,
    `BOOTSTRAP_FILE=${BOOTSTRAP_FILE_STUB}`,
    `STATE_SHA=${shellQuote(probes.stateSha ?? RELEASE)}`,
    `STATE_WEB_IMAGE=${shellQuote(probes.stateWebImage ?? "sha256:web1")}`,
    `STATE_CMS_IMAGE=${shellQuote(probes.stateCmsImage ?? "sha256:cms1")}`,
    shellLine("PROBE_TIMEOUT=("),
    shellLine("FLOOR_COMMIT="),
    `STUB_WEB_LABEL=${shellQuote(probes.webLabel ?? RELEASE_TAG)}`,
    `STUB_CMS_LABEL=${shellQuote(probes.cmsLabel ?? RELEASE_TAG)}`,
    `STUB_WEB_ID=${shellQuote(probes.webId === null ? "" : (probes.webId ?? "sha256:web1"))}`,
    `STUB_CMS_ID=${shellQuote(probes.cmsId === null ? "" : (probes.cmsId ?? "sha256:cms1"))}`,
    `STUB_HANG=${probes.hang ? 1 : 0}`,
    `STUB_SHALLOW=${shellQuote(probes.shallow ?? "false")}`,
    `STUB_AFTER_FLOOR=${shellQuote(` ${(probes.afterFloor ?? [RELEASE, V025]).join(" ")} `)}`,
    "BOUNDED=0",
    "timeout() {",
    '  while [[ "$1" != docker ]]; do shift; done',
    "  if ((STUB_HANG)); then return 124; fi",
    '  local rc=0; BOUNDED=1; "$@" || rc=$?; BOUNDED=0; return "${rc}"',
    "}",
    "docker() {",
    "  if ((BOUNDED)); then printf 'bounded docker %s\\n' \"$*\" >&3; else printf 'UNBOUNDED docker %s\\n' \"$*\" >&3; fi",
    '  local svc=cms; if [[ "${*: -1}" == infra-web:* ]]; then svc=web; fi',
    '  local id_var="STUB_${svc^^}_ID" label_var="STUB_${svc^^}_LABEL"',
    '  [[ "$1 $2" == "image inspect" && -n "${!id_var}" ]] || return 1',
    '  if [[ "$*" == *"{{.Id}}"* ]]; then printf \'%s\\n\' "${!id_var}"; else printf \'%s\\n\' "${!label_var:-<no value>}"; fi',
    "}",
    "git_stub() {",
    '  case "$*" in',
    '    "rev-parse --is-shallow-repository") echo "${STUB_SHALLOW}" ;;',
    '    "rev-parse --verify -q "*)',
    '      case "${*: -1}" in',
    knownCases,
    "        *) return 1 ;;",
    "      esac ;;",
    '    "merge-base --is-ancestor "*)',
    '      [[ "$3" == "${FLOOR_COMMIT}" && "${STUB_AFTER_FLOOR}" == *" $4 "* ]] ;;',
    "    *) return 2 ;;",
    "  esac",
    "}",
    "GIT=(git_stub)",
    shellFunction("image_field"),
    shellFunction("rollback_target_commit"),
    shellFunction("print_rollback_hint"),
    "print_rollback_hint",
    "",
  ].join("\n");
  const res = runBash(script);
  expect(res.status, res.stderr).toBe(0);
  return { stdout: res.stdout, stderr: res.stderr };
}

/** Asserts that `text` holds the needles in this order, each after the one before. */
function expectInOrder(text: string, needles: readonly string[]): void {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    expect(at, `"${needle}" after offset ${from} in:\n${text}`).toBeGreaterThanOrEqual(0);
    from = at + needle.length;
  }
}

describe("rollback hint: a verified v0.25+ target only (upgrade floor, v0.29)", BASH_BUDGET, () => {
  const UNVERIFIED = "is not a verified v0.25+ release:";

  it("pins the floor to the v0.25.0 commit", () => {
    expect(shellAssignment("FLOOR_COMMIT")).toBe(V025);
  });

  it.skipIf(!HAS_BASH)(
    "retags the state's images of a labelled release, bounded, and names the state",
    () => {
      const { stdout, stderr } = rollbackHintRun();
      expectInOrder(stderr, [
        `To roll back to the last-known-good deploy ${RELEASE_TAG} (2026-10-23T18:06:00+02:00) (commit ${RELEASE_TAG}), retag, then start without a build:`,
        `docker tag infra-web:${RELEASE_TAG} infra-web:latest`,
        `docker tag infra-cms:${RELEASE_TAG} infra-cms:latest`,
        `${HINT_COMPOSE_LINE} up -d --no-build web cms`,
        "(--no-build is essential",
        `Rollback target: the last-known-good state (${STATE_FILE_STUB}); a re-run of this`,
        'docs/UPGRADE.md, "Rollback"',
      ]);
      expect(stderr).not.toContain(UNVERIFIED);
      expect(stdout).not.toContain("UNBOUNDED");
      expect(stdout).toContain(
        `bounded docker image inspect -f {{ index .Config.Labels "org.opencontainers.image.revision" }} infra-web:${RELEASE_TAG}`,
      );
    },
  );

  it.skipIf(!HAS_BASH)(
    "takes the state's SHA for v0.25 images without a label when their ids match the state",
    () => {
      const v025 = { stateSha: V025, webLabel: "", cmsLabel: "", ref: V025.slice(0, 12) };
      expect(rollbackHintRun(v025).stderr).toContain(`(commit ${V025.slice(0, 12)}), retag`);
      // Another image under that tag: its id is not the recorded one.
      const moved = rollbackHintRun({ ...v025, webId: "sha256:other" }).stderr;
      expect(moved).toContain(UNVERIFIED);
      expect(moved).not.toContain("docker tag");
    },
  );

  it.skipIf(!HAS_BASH)(
    "never takes the state for :rollback, so unlabelled :rollback images are unverified",
    () => {
      const unlabelled = rollbackHintRun({ ref: "rollback", webLabel: "", cmsLabel: "" }).stderr;
      expectInOrder(unlabelled, [
        `The rollback target rollback (infra-web:rollback, infra-cms:rollback) ${UNVERIFIED}`,
        'Check it by hand (docs/UPGRADE.md, "Rollback"); releases before v0.25:',
        "docs/archive/deployment-history.md.",
        "Rollback target: :rollback, the images that ran before the first deploy with this script",
        `(${BOOTSTRAP_FILE_STUB}, docs/UPGRADE.md, "Rollback").`,
      ]);
      expect(unlabelled).not.toContain("docker tag");
      // Labelled :rollback images of a release are fine.
      expect(rollbackHintRun({ ref: "rollback" }).stderr).toContain(
        "docker tag infra-web:rollback infra-web:latest",
      );
    },
  );

  it.skipIf(!HAS_BASH)("refuses every target it cannot trace to v0.25.0 or later", () => {
    const cases: Array<[string, HintProbes]> = [
      [
        "before the floor",
        {
          ref: OLD.slice(0, 12),
          webLabel: OLD.slice(0, 12),
          cmsLabel: OLD.slice(0, 12),
          stateSha: OLD,
          known: { [OLD.slice(0, 12)]: OLD, [OLD]: OLD },
        },
      ],
      [
        // The state names v0.25, but its tags now name the failed release.
        "labels that disagree with the state",
        { ref: V025.slice(0, 12), stateSha: V025 },
      ],
      ["a state SHA that is not the tag's", { stateSha: V025 }],
      ["a commit the checkout does not know", { known: {} }],
      ["a shallow clone", { shallow: "true" }],
      ["no git answer", { shallow: "" }],
      [
        "web and cms from different commits",
        {
          cmsLabel: V025.slice(0, 12),
          known: { [RELEASE_TAG]: RELEASE, [V025.slice(0, 12)]: V025 },
        },
      ],
      ["a missing image", { webId: null }],
      ["no label and no recorded id", { webLabel: "<no value>", stateWebImage: "" }],
      ["a hung docker daemon", { hang: true }],
    ];
    for (const [name, probes] of cases) {
      const { stdout, stderr } = rollbackHintRun(probes);
      expect(stderr, name).toContain(UNVERIFIED);
      expect(stderr, name).not.toContain("docker tag");
      expect(stderr, name).toContain("Rollback target: the last-known-good state");
      expect(stdout, name).not.toContain("UNBOUNDED");
    }
  });

  it.skipIf(!HAS_BASH)("says there is nothing to roll back to on a fresh install", () => {
    const { stdout, stderr } = rollbackHintRun({ ref: "" });
    expect(stderr).toContain("There is no earlier release on this host to roll back to");
    expect(stderr).not.toContain("docker tag");
    expect(stdout).not.toContain("docker ");
  });
});

/** The host the tests' instance runs on (not a placeholder). */
const TEST_HOST = "intranet.acme.test";

/** Where an instance's Traefik routers and public URLs point (5A-T1). */
interface TraefikHosts {
  /** What compose renders into every router's Host() (DOMAIN). */
  domain?: string;
  /** WEB_PUBLIC_URL, which compose hands the web as AUTH_URL. */
  webUrl?: string;
  /** CMS_PUBLIC_URL, which compose hands the cms as PUBLIC_URL. */
  cmsUrl?: string;
  /** A different host for the cms router only. */
  cmsRouterDomain?: string;
}

/**
 * `docker compose config --format json` of the Traefik mode as Go writes it:
 * the five router rules of infra/docker-compose.traefik.yml with the
 * rendered host (`&&` escaped), the web's AUTH_URL and the cms's
 * PUBLIC_URL, plus `cmsEnv` in the cms environment.
 */
function traefikComposeJson(hosts: TraefikHosts = {}, cmsEnv: Record<string, string> = {}): string {
  const domain = hosts.domain ?? TEST_HOST;
  const host = (name: string) => `Host(\`${name}\`)`;
  const json = JSON.stringify(
    {
      services: {
        cms: {
          environment: {
            ...cmsEnv,
            CORS_ORIGIN: hosts.webUrl ?? `https://${domain}`,
            PUBLIC_URL: hosts.cmsUrl ?? `https://${domain}`,
          },
          labels: {
            "traefik.enable": "true",
            "traefik.http.routers.sinnlos-cms.rule": `${host(hosts.cmsRouterDomain ?? domain)} && (PathPrefix(\`/api\`) || PathPrefix(\`/admin\`))`,
            "traefik.http.routers.sinnlos-cms.priority": "50",
          },
        },
        web: {
          environment: {
            AUTH_URL: hosts.webUrl ?? `https://${domain}`,
            STRAPI_PUBLIC_URL: hosts.cmsUrl ?? `https://${domain}`,
          },
          labels: {
            "traefik.http.routers.sinnlos-auth.rule": `${host(domain)} && PathPrefix(\`/api/auth\`)`,
            "traefik.http.routers.sinnlos-live.rule": `${host(domain)} && PathPrefix(\`/live/\`)`,
            "traefik.http.routers.sinnlos-signin.rule": `${host(domain)} && (Path(\`/sign-in\`) || Path(\`/register\`)) && Method(\`POST\`)`,
            "traefik.http.routers.sinnlos-web.rule": host(domain),
            "traefik.http.routers.sinnlos-web.service": "sinnlos-web",
          },
        },
      },
    },
    null,
    2,
  );
  return json.replace(
    /[<>&]/g,
    (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The preflight of deploy.sh from its scan to "Preflight OK", in bash, with
 * compose answering `env` (the cms service) in a Traefik mode whose routers
 * and public URLs point at `hosts` (by default one real host), and the
 * wiki-revision probe stubbed (`revisions`), and `docker ps` listing the
 * containers' config_files labels (`containers`).
 */
function preflightRun(
  env: Record<string, string>,
  hosts: TraefikHosts = {},
  revisions: { dpOff: boolean; drafts: string } = { dpOff: false, drafts: "0" },
  containers: { configFiles?: string; psFail?: boolean } = {},
): {
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
    `checkout_revisions_dp_off() { return ${revisions.dpOff ? 0 : 1}; }`,
    `revision_draft_rows() { printf '%s' ${shellQuote(revisions.drafts)}; }`,
    `docker() { ${containers.psFail ? "return 1" : `printf '%s\\n' ${shellQuote(containers.configFiles ?? "")}`}; }`,
    shellLine("PROBE_TIMEOUT=("),
    shellLine("REVISION_DP_RUNBOOK="),
    "INFRA_DIR=/srv/infra",
    // The owner's host: a host Traefik (v0.26 made the edge a setting).
    "DEPLOY_EDGE=traefik",
    "PROJECT=infra",
    "compose_stub() {",
    "cat <<'COMPOSE_JSON'",
    traefikComposeJson(hosts, env),
    "COMPOSE_JSON",
    "}",
    "COMPOSE=(compose_stub)",
    `PREFLIGHT_FATAL_KEYS=${shellQuote(shellAssignment("PREFLIGHT_FATAL_KEYS"))}`,
    `PREFLIGHT_WARN_KEYS=${shellQuote(shellAssignment("PREFLIGHT_WARN_KEYS"))}`,
    shellFunction("preflight_scan"),
    shellFunction("compose_env_value"),
    shellLine("TRAEFIK_HOST_RE="),
    shellLine("TRAEFIK_HOST_PLACEHOLDER_RE="),
    shellFunction("url_host"),
    shellFunction("traefik_host_scan"),
    shellFunction("caddy_host_scan"),
    shellFunction("site_closed"),
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

  it.skipIf(!HAS_BASH)("only notes a real app registration left without ENTRA_ENABLED=1", () => {
    const run = preflightRun(entraOff(CLIENT, "client-secret-value"));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Preflight OK");
    expect(run.stderr).toContain("NOTE: MS_CLIENT_ID/MS_CLIENT_SECRET are set in infra/.env");
    expect(run.stderr).not.toContain("WARNING");
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

describe("Meilisearch preflight message and exit code (v0.21)", BASH_BUDGET, () => {
  it.skipIf(!HAS_BASH)(
    "refuses MEILISEARCH_ENABLED=1 without the profile, naming keys only",
    () => {
      const run = preflightRun({
        MEILISEARCH_ENABLED: "1",
        MEILISEARCH_URL: "http://sinnlos-meili:7700",
        MEILISEARCH_WRITE_KEY: "write-key-value-0123456789",
        MEILISEARCH_SEARCH_KEY: "",
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "ERROR: Meilisearch settings in infra/.env are missing or invalid: COMPOSE_PROFILES MEILISEARCH_SEARCH_KEY",
      );
      expect(run.stderr).toContain('"Meilisearch (optional search)"');
      expect(run.stderr).not.toContain("write-key-value-0123456789");
      expect(run.stdout).not.toContain("Preflight OK");
    },
  );

  it.skipIf(!HAS_BASH)("passes silently while the module is off", () => {
    const run = preflightRun({
      MEILISEARCH_ENABLED: "0",
      MEILISEARCH_URL: "http://sinnlos-meili:7700",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
  });
});

describe("Traefik host preflight: DOMAIN fits the instance (5A-T1)", BASH_BUDGET, () => {
  const TRAEFIK = read("infra", "docker-compose.traefik.yml");
  const LIVE_SMOKE = read("infra", "live-smoke.sh");

  /** traefik_host_scan of deploy.sh on `json`: its "host …" and "problem …" lines. */
  function hostScan(json: string): { host: string; problems: string[] } {
    const run = runBash(
      [
        "set -euo pipefail",
        shellFunction("compose_env_value"),
        shellLine("TRAEFIK_HOST_RE="),
        shellLine("TRAEFIK_HOST_PLACEHOLDER_RE="),
        shellFunction("url_host"),
        shellFunction("traefik_host_scan"),
        "traefik_host_scan <<'COMPOSE_JSON'",
        json,
        "COMPOSE_JSON",
        "",
      ].join("\n"),
    );
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter(Boolean);
    return {
      host: lines.find((l) => l.startsWith("host "))?.slice(5) ?? "",
      problems: lines.filter((l) => l.startsWith("problem ")).map((l) => l.slice(8)),
    };
  }
  const scan = (hosts: TraefikHosts) => hostScan(traefikComposeJson(hosts));

  it("renders DOMAIN into every router rule, and hands the apps the URLs the scan reads", () => {
    const rules = TRAEFIK.split("\n").filter((l) => /traefik\.http\.routers\.[^.]+\.rule=/.test(l));
    expect(rules).toHaveLength(5);
    for (const rule of rules) {
      expect(rule).toMatch(/rule=Host\(`\$\{DOMAIN:\?[^}]*\}`\)/);
    }
    // The scan compares DOMAIN with the web's AUTH_URL and the cms's PUBLIC_URL.
    expect(COMPOSE).toMatch(/^ {6}AUTH_URL: \$\{WEB_PUBLIC_URL\}$/m);
    expect(COMPOSE).toMatch(/^ {6}PUBLIC_URL: \$\{CMS_PUBLIC_URL\}$/m);
  });

  it.skipIf(!HAS_BASH)("passes a bare host that is the host of both public URLs", () => {
    expect(scan({})).toEqual({ host: TEST_HOST, problems: [] });
    // Host names compare without case; a port or path in the URLs is no part of the host.
    expect(
      scan({
        domain: "Intranet.ACME.test",
        webUrl: `https://${TEST_HOST}:443/`,
        cmsUrl: `HTTPS://${TEST_HOST}/`,
      }).problems,
    ).toEqual([]);
  });

  it.skipIf(!HAS_BASH)("refuses a DOMAIN that is not a bare host name", () => {
    for (const domain of [
      `https://${TEST_HOST}`,
      `${TEST_HOST}:443`,
      `${TEST_HOST}/`,
      ` ${TEST_HOST}`,
      "intranet_acme.test",
      "-intranet.acme.test",
      "intranet..acme.test",
    ]) {
      const result = scan({
        domain,
        webUrl: `https://${TEST_HOST}`,
        cmsUrl: `https://${TEST_HOST}`,
      });
      expect(result.problems, domain).toEqual([
        `DOMAIN=${domain} is not a bare host name (the name alone: no scheme, port, path or blank)`,
      ]);
    }
  });

  it.skipIf(!HAS_BASH)("refuses an empty DOMAIN and routers without a Host() or one host", () => {
    expect(scan({ domain: "" }).problems).toEqual(["DOMAIN is empty"]);
    expect(scan({ cmsRouterDomain: "other.acme.test" }).problems).toEqual([
      `the Traefik routers match different hosts: Host(\`${TEST_HOST}\`) Host(\`other.acme.test\`) `,
    ]);
    expect(hostScan(composeJson({ AUTH_URL: `https://${TEST_HOST}` })).problems).toEqual([
      "no Traefik router rule has a Host() matcher",
    ]);
  });

  it.skipIf(!HAS_BASH)("refuses the example host and other placeholders", () => {
    for (const domain of [
      "intranet.example.com",
      "example.org",
      "sinnlos.example.net",
      "intranet.example",
      "host.invalid",
      "your-domain.tld",
      "change-me.acme.test",
    ]) {
      // Even when the public URLs say the same (as in infra/.env.example).
      expect(scan({ domain }).problems, domain).toEqual([
        `DOMAIN=${domain} is a placeholder (infra/.env.example), not this instance's host name`,
      ]);
    }
    expect(scan({ domain: "example-intranet.acme.test" }).problems).toEqual([]);
  });

  it.skipIf(!HAS_BASH)("refuses the values infra/.env.example ships", () => {
    const example = read("infra", ".env.example");
    const value = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(example)?.[1] ?? "";
    expect(
      scan({
        domain: value("DOMAIN"),
        webUrl: value("WEB_PUBLIC_URL"),
        cmsUrl: value("CMS_PUBLIC_URL"),
      }).problems,
    ).toEqual([
      "DOMAIN=intranet.example.com is a placeholder (infra/.env.example), not this instance's host name",
    ]);
  });

  it.skipIf(!HAS_BASH)(
    "refuses a DOMAIN that is not the host of WEB_PUBLIC_URL or CMS_PUBLIC_URL",
    () => {
      expect(scan({ webUrl: "https://www.acme.test" }).problems).toEqual([
        `DOMAIN=${TEST_HOST} is not the host of WEB_PUBLIC_URL (www.acme.test)`,
      ]);
      expect(scan({ cmsUrl: "https://cms.acme.test" }).problems).toEqual([
        `DOMAIN=${TEST_HOST} is not the host of CMS_PUBLIC_URL (cms.acme.test)`,
      ]);
      expect(scan({ webUrl: "", cmsUrl: TEST_HOST }).problems).toEqual([
        `DOMAIN=${TEST_HOST} is not the host of WEB_PUBLIC_URL (no http(s) URL)`,
        `DOMAIN=${TEST_HOST} is not the host of CMS_PUBLIC_URL (no http(s) URL)`,
      ]);
    },
  );

  it.skipIf(!HAS_BASH)("fails the preflight, naming DOMAIN, and passes with a fitting one", () => {
    const bad = preflightRun({}, { domain: "https://intranet.acme.test" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("ERROR: DOMAIN in infra/.env does not fit this instance:");
    expect(bad.stderr).toContain(
      "       - DOMAIN=https://intranet.acme.test is not a bare host name (the name alone: no scheme, port, path or blank)",
    );
    expect(bad.stderr).toContain("Preflight failed. Nothing was changed.");
    expect(bad.stdout).not.toContain("Preflight OK");
    const placeholder = preflightRun({}, { domain: "intranet.example.com" });
    expect(placeholder.status).toBe(1);
    expect(placeholder.stderr).toContain("DOMAIN=intranet.example.com is a placeholder");
    const good = preflightRun({});
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("Preflight OK");
    expect(good.stderr).toBe("");
  });

  it("takes the smoke URL from the checked host, not from the owner's host name", () => {
    const lines = DEPLOY.split("\n");
    const ok = lines.indexOf('log "Preflight OK"');
    // Traefik: the host every router matches; Caddy (v0.26): WEB_PUBLIC_URL.
    const smoke = lines.indexOf('  SMOKE_URL="${SMOKE_URL:-https://${EDGE_HOST}}"');
    const caddySmoke = lines.indexOf('  SMOKE_URL="${SMOKE_URL:-${EDGE_ORIGIN}}"');
    expect(ok).toBeGreaterThan(0);
    // Right after the preflight (so --check prints it), before any smoke-check use.
    expect(smoke).toBeGreaterThan(ok);
    expect(caddySmoke).toBeGreaterThan(smoke);
    expect(lines.slice(ok, smoke).join("\n")).not.toMatch(/\$\{SMOKE_URL\}/);
    expect(DEPLOY).toContain('SMOKE_URL="${SMOKE_URL:-}"');
    // No owner host name as a default in either script, comments aside.
    for (const script of [DEPLOY, LIVE_SMOKE]) {
      const code = script.split("\n").filter((l) => !l.trim().startsWith("#"));
      expect(code.join("\n")).not.toContain("sinnlos.yurtbay.dev");
    }
    expect(LIVE_SMOKE).toContain(
      'DOMAIN="${DOMAIN:-$(env_file_value DOMAIN "${SCRIPT_DIR}/.env")}"',
    );
    expect(LIVE_SMOKE).toContain('BASE_URL="https://${DOMAIN}"');
    // live-smoke's bare host rule is deploy.sh's.
    expect(LIVE_SMOKE).toContain(
      `host_re=${shellLine("TRAEFIK_HOST_RE=").slice("TRAEFIK_HOST_RE=".length)}`,
    );
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

    it.skipIf(!HAS_BASH)(
      "runs it on an identity-provider-only instance (Entra or OIDC) without the credentials file",
      () => {
        for (const idp of ["ENTRA_ENABLED", "OIDC_ENABLED"]) {
          expect(
            liveSmokeMode({ LIVE_EVENTS_DISABLED: "0", [idp]: "1", AUTH_LOCAL_ENABLED: "0" }),
            idp,
          ).toMatch(/^run \(identity provider only/);
          // With local sign-in next to the provider the demo accounts sign in as usual.
          expect(
            liveSmokeMode({ LIVE_EVENTS_DISABLED: "0", [idp]: "1", AUTH_LOCAL_ENABLED: "1" }),
            idp,
          ).toMatch(/^skip: demo credentials file .* not readable/);
        }
        // Exactly "1", as the apps read it.
        expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "0", OIDC_ENABLED: "true" })).toMatch(
          /^skip: demo credentials file .* not readable/,
        );
        // The record step keys on that prefix.
        expect(DEPLOY).toContain('"${LIVE_SMOKE_MODE}" == "run (identity provider only"*');
      },
    );

    it.skipIf(!HAS_BASH)("needs the credentials file, or both passwords in the environment", () => {
      expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "0" })).toMatch(/^skip: demo credentials file/);
      expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "0" }, { passwords: true })).toBe("run");
      expect(liveSmokeMode({ LIVE_EVENTS_DISABLED: "0" }, { smokeEnv: true })).toBe("run");
    });
  },
);

describe("preflight: retired legacy-zone overrides (v0.29)", BASH_BUDGET, () => {
  const fits = { ENTRA_ENABLED: "0" };
  const files = (...names: string[]) => names.map((n) => `/srv/infra/${n}`).join(",");

  it.skipIf(!HAS_BASH)(
    "refuses containers started with one, running or stopped, naming the way out",
    () => {
      const listed = [
        files(
          "docker-compose.yml",
          "docker-compose.traefik.yml",
          "docker-compose.cms-legacy-tz.yml",
        ),
        files("docker-compose.yml", "docker-compose.web-legacy-tz.yml"),
      ].join("\n");
      const run = preflightRun(fits, {}, undefined, { configFiles: listed });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "ERROR: containers of compose project infra were started with docker-compose.cms-legacy-tz.yml docker-compose.web-legacy-tz.yml (the legacy-zone",
      );
      expect(run.stderr).toContain("upgrade through v0.28.x first (docs/UPGRADE.md)");
      expect(run.stderr).toContain("compose_stub up -d --no-build --force-recreate web cms");
      expect(run.stderr).toContain("Preflight failed. Nothing was changed.");
    },
  );

  it.skipIf(!HAS_BASH)(
    "passes the supported files, no containers, and refuses a failed listing",
    () => {
      for (const configFiles of [files("docker-compose.yml", "docker-compose.traefik.yml"), ""]) {
        const run = preflightRun(fits, {}, undefined, { configFiles });
        expect(run.status, run.stderr).toBe(0);
      }
      const failed = preflightRun(fits, {}, undefined, { psFail: true });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        "ERROR: docker ps failed, so deploy.sh cannot tell which compose files",
      );
    },
  );
});

describe("preflight: a site closed at the edge (SITE_ALLOW_CIDRS, v0.29)", BASH_BUDGET, () => {
  const fits = { ENTRA_ENABLED: "0" };

  it.skipIf(!HAS_BASH)("refuses to deploy while the site is closed, naming the restore", () => {
    for (const ranges of ["203.0.113.7/32", "203.0.113.0/24, 2001:db8::/32"]) {
      const run = preflightRun({ ...fits, SITE_ALLOW_CIDRS: ranges });
      expect(run.status, ranges).toBe(1);
      expect(run.stdout).not.toContain("Preflight OK");
      expect(run.stderr).toContain(
        "ERROR: the site is closed (SITE_ALLOW_CIDRS); open it before deploying.",
      );
      expect(run.stderr).toContain('(docs/OPERATIONS.md, "Restore")');
      expect(run.stderr).toContain("Preflight failed. Nothing was changed.");
    }
  });

  it.skipIf(!HAS_BASH)("deploys an open site: unset, empty, or with an open range", () => {
    for (const ranges of [undefined, "", "0.0.0.0/0,::/0", "203.0.113.7/32,::/0"]) {
      const env = ranges === undefined ? fits : { ...fits, SITE_ALLOW_CIDRS: ranges };
      const run = preflightRun(env);
      expect(run.status, `${ranges}: ${run.stderr}`).toBe(0);
      expect(run.stderr).not.toContain("the site is closed");
    }
  });

  it.skipIf(!HAS_BASH)("reads the Traefik middleware range as well", () => {
    const label = "traefik.http.middlewares.sinnlos-site-allow.ipallowlist.sourcerange";
    const json = (range: string) =>
      JSON.stringify({ services: { web: { labels: { [label]: range } } } }, null, 2);
    const closed = (range: string) =>
      runBash(
        [shellFunction("site_closed"), "cat <<'JSON' | site_closed", json(range), "JSON", ""].join(
          "\n",
        ),
      ).status;
    expect(closed("203.0.113.7/32")).toBe(0);
    expect(closed("0.0.0.0/0,::/0")).toBe(1);
  });

  it("is the same function restore-db.sh uses for its reminder", () => {
    // One rule for "closed": deploy refuses and restore stays quiet on exactly
    // the same rendered configuration.
    const restore = read("infra", "restore-db.sh");
    const start = restore.indexOf("\nsite_closed() {\n");
    expect(start).toBeGreaterThan(-1);
    const end = restore.indexOf("\n}\n", start + 1);
    expect(restore.slice(start + 1, end + 2)).toBe(shellFunction("site_closed"));
  });
});

describe("preflight: wiki revision draft rows (batch 16, DA03)", BASH_BUDGET, () => {
  const fits = { ENTRA_ENABLED: "0" };

  it.skipIf(!HAS_BASH)(
    "refuses before the backup while the database holds draft rows, naming preflight and migrate.sql",
    () => {
      const run = preflightRun(fits, {}, { dpOff: true, drafts: "12" });
      expect(run.status).toBe(1);
      expect(run.stdout).not.toContain("Preflight OK");
      expect(run.stderr).toContain(
        "ERROR: the running database holds 12 wiki revision draft row(s), and this release runs",
      );
      expect(run.stderr).toContain("/srv/infra/migrations/wiki-revision-dp/preflight.sql");
      expect(run.stderr).toContain(
        'psql -X -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"\' < /srv/infra/migrations/wiki-revision-dp/migrate.sql',
      );
      expect(run.stderr).toContain("(infra/migrations/wiki-revision-dp/README.md), then re-run.");
      expect(run.stderr).toContain("Preflight failed. Nothing was changed.");
    },
  );

  it.skipIf(!HAS_BASH)(
    "passes with a line when there are none, or the database cannot be asked",
    () => {
      const none = preflightRun(fits, {}, { dpOff: true, drafts: "0" });
      expect(none.status, none.stderr).toBe(0);
      expect(none.stdout).toContain("  wiki revisions: no draft rows");
      const unknown = preflightRun(fits, {}, { dpOff: true, drafts: "" });
      expect(unknown.status, unknown.stderr).toBe(0);
      expect(unknown.stdout).toContain("  wiki revisions: not checked (no database to ask)");
    },
  );

  it.skipIf(!HAS_BASH)(
    "asks nothing for a checkout that runs wiki revisions with draft & publish",
    () => {
      const run = preflightRun(fits, {}, { dpOff: false, drafts: "12" });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).not.toContain("wiki revisions");
    },
  );

  it("the probe is bounded and reads the checkout's schema", () => {
    const probe = shellFunction("revision_draft_rows");
    expect(probe).toContain("SET lock_timeout = '5s';");
    expect(probe).toContain("SET statement_timeout = '10s';");
    expect(probe).toContain("psql -X -q -tA");
    expect(probe).toContain(
      "SELECT count(*) FROM public.wiki_revisions WHERE published_at IS NULL;",
    );
    expect(DEPLOY).toContain(
      'REVISION_DRAFTS="$(revision_draft_rows "${PROBE_TIMEOUT[@]}" || true)"',
    );
    expect(shellLine("PROBE_TIMEOUT=(")).toBe("PROBE_TIMEOUT=(timeout -k 5 15)");
    expect(shellAssignment("REVISION_SCHEMA")).toBe(
      "apps/cms/src/api/wiki-revision/content-types/wiki-revision/schema.json",
    );
  });

  it("reads the checkout's schema", () => {
    expect(shellFunction("checkout_revisions_dp_off")).toContain(
      `grep -Eq '"draftAndPublish"[[:space:]]*:[[:space:]]*false' "\${CHECKOUT}/\${REVISION_SCHEMA}"`,
    );
  });
});

describe("Caddy host preflight: DOMAIN, ports and schemes (v0.26)", BASH_BUDGET, () => {
  /** caddy_host_scan of deploy.sh: its "problem …" lines. */
  function caddyScan(domain: string, webUrl: string, cmsUrl = webUrl): string[] {
    const json = JSON.stringify(
      {
        services: {
          caddy: { environment: { DOMAIN: domain } },
          cms: { environment: { PUBLIC_URL: cmsUrl } },
          web: { environment: { AUTH_URL: webUrl } },
        },
      },
      null,
      2,
    );
    const run = runBash(
      [
        "set -euo pipefail",
        shellFunction("compose_env_value"),
        shellLine("TRAEFIK_HOST_RE="),
        shellLine("TRAEFIK_HOST_PLACEHOLDER_RE="),
        shellLine("CADDY_PORT_RE="),
        shellFunction("url_host"),
        shellFunction("caddy_host_scan"),
        "caddy_host_scan <<'COMPOSE_JSON'",
        json,
        "COMPOSE_JSON",
        "",
      ].join("\n"),
    );
    expect(run.status, run.stderr).toBe(0);
    return run.stdout
      .split("\n")
      .filter((l) => l.startsWith("problem "))
      .map((l) => l.slice(8));
  }

  it.skipIf(!HAS_BASH)("passes HTTPS on 443 and plain HTTP on localhost", () => {
    expect(caddyScan("intranet.acme.test", "https://intranet.acme.test")).toEqual([]);
    expect(caddyScan("https://intranet.acme.test:443", "https://intranet.acme.test:443/")).toEqual(
      [],
    );
    expect(caddyScan("localhost", "https://localhost")).toEqual([]);
    expect(caddyScan("http://localhost", "http://localhost")).toEqual([]);
    expect(caddyScan("http://localhost:80", "http://localhost:80/")).toEqual([]);
  });

  it.skipIf(!HAS_BASH)("refuses another port: compose publishes only 80 and 443", () => {
    expect(caddyScan("intranet.acme.test:8443", "https://intranet.acme.test")).toEqual([
      "DOMAIN=intranet.acme.test:8443 names port 8443: the bundled Caddy serves https on port 443 only",
    ]);
    expect(caddyScan("intranet.acme.test", "https://intranet.acme.test:8443")).toEqual([
      "WEB_PUBLIC_URL=https://intranet.acme.test:8443 names port 8443: the bundled Caddy serves https on port 443 only",
      "CMS_PUBLIC_URL=https://intranet.acme.test:8443 names port 8443: the bundled Caddy serves https on port 443 only",
    ]);
    expect(caddyScan("http://localhost:8080", "http://localhost:8080")).toContain(
      "DOMAIN=http://localhost:8080 names port 8080: the bundled Caddy serves http on port 80 only",
    );
  });

  it.skipIf(!HAS_BASH)("refuses public URLs with the scheme Caddy does not serve", () => {
    expect(
      caddyScan(
        "http://intranet.acme.test",
        "https://intranet.acme.test",
        "http://intranet.acme.test",
      ),
    ).toEqual([
      "WEB_PUBLIC_URL=https://intranet.acme.test is not an http:// URL, and DOMAIN=http://intranet.acme.test makes Caddy serve http",
    ]);
    expect(caddyScan("intranet.acme.test", "http://intranet.acme.test")).toEqual([
      "WEB_PUBLIC_URL=http://intranet.acme.test is not an https:// URL, and DOMAIN=intranet.acme.test makes Caddy serve https",
      "CMS_PUBLIC_URL=http://intranet.acme.test is not an https:// URL, and DOMAIN=intranet.acme.test makes Caddy serve https",
    ]);
  });
});
