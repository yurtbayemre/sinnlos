import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { requireFromPackage, strapiPackageDir } from "../src/test/sqlite-engine.test.helper";
import pluginsConfig, { OFFICE_MACRO_DENIED_TYPES, smtpTransportSecurity } from "./plugins";

/**
 * The digest mailer's SMTP transport (roadmap B05): port 465 is implicit
 * TLS, every other port STARTTLS with requireTLS. Before, the transport was
 * hard-coded to STARTTLS, so a 465-only server could not be used at all.
 */

type EnvStore = Record<string, string>;

/** Minimal stand-in for Strapi's env helper (what plugins.ts uses). */
const makeEnv = (store: EnvStore = {}) =>
  Object.assign((key: string, def?: unknown) => store[key] ?? def, {
    int: (key: string, def?: number) => (key in store ? parseInt(store[key], 10) : (def as number)),
    bool: (key: string, def?: boolean) => (key in store ? store[key] === "true" : (def as boolean)),
    array: (key: string, def?: string[]) =>
      key in store ? store[key].split(",") : (def as string[]),
  });

const transportFor = (store: EnvStore) =>
  pluginsConfig({ env: makeEnv({ SMTP_HOST: "mail.example.com", ...store }) }).email.config
    .providerOptions;

describe("config/plugins.ts users-permissions JWTs", () => {
  it("pins legacy JWTs of 7 days: the token version (FX40) and the web session rely on them", () => {
    const config = pluginsConfig({ env: makeEnv({ JWT_SECRET: "s" }) })["users-permissions"].config;
    expect(config).toMatchObject({
      jwt: { expiresIn: "7d" },
      jwtManagement: "legacy-support",
      jwtSecret: "s",
    });
  });
});

describe("config/plugins.ts users-permissions sign-in throttle", () => {
  it("keeps the plugin's throttle unless E2E_AUTH_THROTTLE_OFF is exactly 1 (e2e only)", () => {
    const ratelimit = (store: EnvStore) =>
      (
        pluginsConfig({ env: makeEnv(store) })["users-permissions"].config as Record<
          string,
          unknown
        >
      ).ratelimit;
    for (const value of [undefined, "", "0", "true", "yes"])
      expect(
        ratelimit(value === undefined ? {} : { E2E_AUTH_THROTTLE_OFF: value }),
        value,
      ).toBeUndefined();
    expect(ratelimit({ E2E_AUTH_THROTTLE_OFF: "1" })).toEqual({ enabled: false });
  });
});

describe("config/plugins.ts SMTP transport (B05)", () => {
  it("uses STARTTLS (requireTLS) on the default port 587", () => {
    expect(transportFor({})).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(transportFor({ SMTP_PORT: "587" })).toMatchObject({ secure: false, requireTLS: true });
  });

  it("uses implicit TLS on port 465", () => {
    expect(transportFor({ SMTP_PORT: "465" })).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
    });
  });

  it("keeps STARTTLS required on any other port", () => {
    expect(smtpTransportSecurity(25)).toEqual({ secure: false, requireTLS: true });
    expect(smtpTransportSecurity(2525)).toEqual({ secure: false, requireTLS: true });
  });

  it("authenticates only when SMTP_USER is set", () => {
    expect(transportFor({}).auth).toBeUndefined();
    expect(transportFor({ SMTP_USER: "noreply@example.com", SMTP_PASS: "app-pass" }).auth).toEqual({
      user: "noreply@example.com",
      pass: "app-pass",
    });
  });
});

describe("config/plugins.ts upload backstop (decision 06 §E1, amendment 2)", () => {
  const security = () => pluginsConfig({ env: makeEnv() }).upload.config.security;

  /** @strapi/upload's matchesMimePattern: lower-cased, `*` as `.*` (pinned in upload-validation.contract.test.ts). */
  const denied = (mime: string) =>
    security().deniedTypes.some((pattern: string) => {
      const p = pattern.toLowerCase();
      return p.includes("*")
        ? new RegExp(`^${p.replace(/\*/g, ".*")}$`).test(mime.toLowerCase())
        : p === mime.toLowerCase();
    });

  const uploadDir = () => strapiPackageDir("@strapi/upload");
  const mimeTypes = () =>
    requireFromPackage<{ types: Record<string, string> }>(uploadDir(), "mime-types").types;
  /** Every Office mime file-type 21.3.4 can answer (core.js's mapping table). */
  const fileTypeMimes = (): string[] => {
    const core = readFileSync(join(uploadDir(), "..", "..", "file-type", "core.js"), "utf8");
    return [
      ...new Set(
        core.match(
          /application\/vnd\.(?:ms-(?:word|excel|powerpoint)|openxmlformats-officedocument)[a-z0-9.+-]*/gi,
        ) ?? [],
      ),
    ];
  };
  const OFFICE_EXTENSIONS = [
    "docx",
    "docm",
    "dotx",
    "dotm",
    "xlsx",
    "xlsm",
    "xlsb",
    "xltx",
    "xltm",
    "xlam",
    "pptx",
    "pptm",
    "potx",
    "potm",
    "ppsx",
    "ppsm",
    "ppam",
    "sldm",
    "sldx",
  ];

  it("keeps the twelve earlier types and adds the three macro patterns", () => {
    expect(security().deniedTypes).toHaveLength(15);
    expect(security().deniedTypes.slice(-3)).toEqual([...OFFICE_MACRO_DENIED_TYPES]);
    expect(security().deniedTypes).toContain("image/svg+xml");
  });

  it("matches every macro-enabled Office mime of mime-types and file-type", () => {
    const macro = [...OFFICE_EXTENSIONS.map((ext) => mimeTypes()[ext]), ...fileTypeMimes()].filter(
      (mime) => typeof mime === "string" && /macroenabled/i.test(mime),
    );
    expect(macro.length).toBeGreaterThanOrEqual(10);
    for (const mime of macro) expect(denied(mime), mime).toBe(true);
  });

  it("matches none of the clean Office mimes, PDF or the images", () => {
    const clean = [...OFFICE_EXTENSIONS.map((ext) => mimeTypes()[ext]), ...fileTypeMimes()].filter(
      (mime) => typeof mime === "string" && !/macroenabled/i.test(mime),
    );
    expect(clean).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    for (const mime of [...clean, "application/pdf", "image/jpeg", "image/png", "image/webp"]) {
      expect(denied(mime), mime).toBe(false);
    }
  });
});
