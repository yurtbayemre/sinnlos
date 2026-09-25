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
 *      with a real (GUID) client id, and is fatal.
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
