/**
 * FX13 boot guard: template placeholder secrets refuse the boot in
 * production and only warn elsewhere. The values below are the ones the
 * repo's env templates and docs ship.
 */
import { describe, expect, it } from "vitest";

import {
  GUARDED_SECRET_KEYS,
  enforceSecretGuard,
  findPlaceholderSecrets,
  isPlaceholderSecret,
} from "./env-guard";

const REAL = "q8Jm0tV2cXrW5bN7yZa1LkP4sHd6FgE3uIoRwTyQeA=";

function realEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { NODE_ENV: "production" };
  for (const key of GUARDED_SECRET_KEYS) env[key] = REAL;
  env.APP_KEYS = `${REAL},${REAL.toLowerCase()}`;
  env.DATABASE_PASSWORD = "s3cure-db-pass";
  return { ...env, ...overrides };
}

function recorder() {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    log: {
      warn: (message: string) => warnings.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

describe("isPlaceholderSecret", () => {
  it.each([
    "change-me",
    "change-me-please",
    "change-me-1,change-me-2",
    "toBeModified",
    "toBeModified1,toBeModified2",
    "CHANGEME",
    "generate-with-openssl-rand-base64-32",
    "<secret>",
    "<openssl rand -base64 32>",
    `${REAL},change-me-2`,
    "my-placeholder-value",
  ])("flags %s", (value) => {
    expect(isPlaceholderSecret(value)).toBe(true);
  });

  it.each([undefined, "", REAL, `${REAL},${REAL}`, "a1b2c3d4e5f6", "Changed-Secret-2026!"])(
    "accepts %s",
    (value) => {
      expect(isPlaceholderSecret(value)).toBe(false);
    },
  );
});

describe("findPlaceholderSecrets", () => {
  it("names every guarded key holding a placeholder, never the values", () => {
    const verdict = findPlaceholderSecrets(
      realEnv({ JWT_SECRET: "change-me", APP_KEYS: "toBeModified1,toBeModified2" }),
    );
    expect(verdict.placeholders).toEqual(["APP_KEYS", "JWT_SECRET"]);
    expect(verdict.warnOnly).toEqual([]);
  });

  it("treats DATABASE_PASSWORD as warn-only", () => {
    const verdict = findPlaceholderSecrets(realEnv({ DATABASE_PASSWORD: "change-me-please" }));
    expect(verdict).toEqual({ placeholders: [], warnOnly: ["DATABASE_PASSWORD"] });
  });

  it("covers the internal webhook and upload secrets", () => {
    const verdict = findPlaceholderSecrets(
      realEnv({ REVALIDATE_SECRET: "change-me", INTERNAL_UPLOAD_TOKEN: "<secret>" }),
    );
    expect(verdict.placeholders).toEqual(["REVALIDATE_SECRET", "INTERNAL_UPLOAD_TOKEN"]);
  });
});

describe("enforceSecretGuard", () => {
  it("is silent with real secrets", () => {
    const r = recorder();
    expect(() => enforceSecretGuard(realEnv(), r.log)).not.toThrow();
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("refuses to boot in production with a placeholder", () => {
    const r = recorder();
    expect(() => enforceSecretGuard(realEnv({ ADMIN_JWT_SECRET: "change-me" }), r.log)).toThrow(
      /ADMIN_JWT_SECRET.*Refusing to start in production/,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).not.toContain("change-me");
  });

  it("only warns outside production (the cms .env.example keeps working)", () => {
    for (const NODE_ENV of ["development", undefined, "test"]) {
      const r = recorder();
      const env = realEnv({ NODE_ENV, APP_KEYS: "toBeModified1,toBeModified2" });
      expect(() => enforceSecretGuard(env, r.log)).not.toThrow();
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain("APP_KEYS");
      expect(r.errors).toEqual([]);
    }
  });

  it("never refuses for a placeholder DATABASE_PASSWORD, even in production", () => {
    const r = recorder();
    expect(() =>
      enforceSecretGuard(realEnv({ DATABASE_PASSWORD: "change-me-please" }), r.log),
    ).not.toThrow();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("DATABASE_PASSWORD");
  });

  it("ignores unset secrets (presence is enforced by compose ${VAR:?})", () => {
    const r = recorder();
    const env = realEnv({ REVALIDATE_SECRET: undefined, INTERNAL_UPLOAD_TOKEN: "" });
    expect(() => enforceSecretGuard(env, r.log)).not.toThrow();
    expect(r.warnings).toEqual([]);
  });
});
