import { describe, expect, it } from "vitest";
import pluginsConfig, { smtpTransportSecurity } from "./plugins";

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
    array: (key: string, def?: string[]) => (key in store ? store[key].split(",") : (def as string[])),
  });

const transportFor = (store: EnvStore) =>
  pluginsConfig({ env: makeEnv({ SMTP_HOST: "mail.example.com", ...store }) }).email.config
    .providerOptions;

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
