/**
 * infra/mfa-reset.sh (v0.27, rev3 #11) against a real Postgres 16 in a
 * throwaway container named like a compose db (`<project>-db-1`): exactly
 * one account by lower(email) or nothing changes, the token version goes
 * up, the address is a psql variable (a quote in it is harmless), and the
 * line about the reset comes after the commit. Slow: needs Docker and
 * SINNLOS_SLOW_SHELL_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dockerReachable, runBash, shellMode } from "./shell-runner.test.helper";

const SCRIPT = readFileSync(fileURLToPath(new URL("./mfa-reset.sh", import.meta.url)), "utf8");
const SLOW = process.env.SINNLOS_SLOW_SHELL_TESTS === "1";
const MODE = SLOW ? shellMode(["docker"], { linux: false }) : null;
const PROJECT = `mfareset${process.pid}`;
const DB = `${PROJECT}-db-1`;

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const sql = (query: string) =>
  docker(
    "exec",
    DB,
    "psql",
    "-X",
    "-q",
    "-t",
    "-A",
    "-U",
    "sinnlos",
    "-d",
    "sinnlos",
    "-c",
    query,
  ).stdout.trim();

const reset = (email: string) =>
  runBash(
    [
      "dir=$(mktemp -d)",
      'mkdir -p "$dir/infra"',
      "cat > \"$dir/infra/mfa-reset.sh\" <<'__MFA_RESET__'",
      SCRIPT,
      "__MFA_RESET__",
      // The address single-quoted for bash (a quote inside closes, escapes, reopens).
      `COMPOSE_PROJECT=${PROJECT} bash "$dir/infra/mfa-reset.sh" '${email.replace(/'/g, "'\\''")}'`,
    ].join("\n"),
    MODE!,
  );

describe.skipIf(!SLOW || !dockerReachable(MODE))("infra/mfa-reset.sh on Postgres 16", () => {
  beforeAll(() => {
    docker("rm", "-f", DB);
    const run = docker(
      "run",
      "-d",
      "--name",
      DB,
      "-e",
      "POSTGRES_USER=sinnlos",
      "-e",
      "POSTGRES_DB=sinnlos",
      "-e",
      "POSTGRES_PASSWORD=x",
      "postgres:16-alpine",
    );
    expect(run.status, run.stderr).toBe(0);
    for (let i = 0; i < 60; i++) {
      if (
        docker("exec", DB, "pg_isready", "-U", "sinnlos", "-d", "sinnlos").status === 0 &&
        sql("SELECT 1") === "1"
      )
        break;
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 500)"]);
    }
    sql(`CREATE TABLE up_users (id serial PRIMARY KEY, username text, email text,
      token_version integer, totp_secret text, totp_enabled_at timestamptz,
      totp_last_step integer, totp_recovery_codes jsonb)`);
    sql(`INSERT INTO up_users (username, email, token_version, totp_secret, totp_enabled_at, totp_last_step, totp_recovery_codes) VALUES
      ('anna', 'Anna@Example.com', 3, 'v1:x', now(), 5, '["h"]'),
      ('dup-a', 'dup@example.com', 1, 'v1:y', now(), 1, '[]'),
      ('dup-b', 'DUP@example.com', NULL, 'v1:z', now(), 1, '[]'),
      ('quote', 'o''brien@example.com', NULL, 'v1:q', now(), 2, '[]')`);
  }, 120_000);
  afterAll(() => {
    docker("rm", "-f", DB);
  });

  it("clears exactly that account, case-insensitively, and raises its token version", () => {
    const res = reset("anna@example.com");
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("second factor cleared for user 1 (anna), token version now 4");
    expect(
      sql(
        "SELECT concat_ws('|', totp_secret, totp_enabled_at, totp_last_step, totp_recovery_codes, token_version) FROM up_users WHERE id = 1",
      ),
    ).toBe("4");
  });

  it("changes nothing for no match or for a case duplicate", () => {
    for (const [email, found] of [
      ["nobody@example.com", 0],
      ["dup@example.com", 2],
    ] as const) {
      const res = reset(email);
      expect(res.status, email).not.toBe(0);
      expect(res.stderr, email).toContain(`found ${found}`);
      expect(res.stdout, email).not.toContain("cleared");
    }
    expect(
      sql("SELECT count(*) FROM up_users WHERE totp_secret IS NOT NULL AND username LIKE 'dup-%'"),
    ).toBe("2");
  });

  it("takes an address with a quote as data", () => {
    const res = reset("O'Brien@example.com");
    expect(res.status, res.stderr).toBe(0);
    expect(
      sql(
        "SELECT coalesce(totp_secret, 'cleared') || '|' || token_version FROM up_users WHERE username = 'quote'",
      ),
    ).toBe("cleared|1");
  });
});
