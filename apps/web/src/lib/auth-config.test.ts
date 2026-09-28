import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import de from "../../messages/de.json";
import { ENTRA_SIGN_IN_ERRORS } from "./entra-exchange";
import { EntraWebConfigError, entraLogoutUrl, parseEntraWebConfig } from "./auth-config";

/**
 * The web's sign-in configuration (D-ENTRA-01 spec A): ENTRA_ENABLED is the
 * only switch, an enabled but invalid configuration names each bad
 * variable, and local sign-in stays on while Entra is off. Fake GUIDs only.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const VALID = {
  ENTRA_ENABLED: "1",
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: TENANT,
  AUTH_MICROSOFT_ENTRA_ID_ID: CLIENT,
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret-value",
  ENTRA_EXCHANGE_SECRET: "0123456789abcdef0123456789abcdef",
};

function refused(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseEntraWebConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(EntraWebConfigError);
    return (err as EntraWebConfigError).variables;
  }
  throw new Error("expected an EntraWebConfigError");
}

describe("parseEntraWebConfig", () => {
  it("is off unless ENTRA_ENABLED is exactly '1', whatever the other values hold", () => {
    for (const flag of [undefined, "", "0", "true", "yes"]) {
      expect(parseEntraWebConfig({ ...VALID, ENTRA_ENABLED: flag })).toBeNull();
      expect(parseEntraWebConfig({ ENTRA_ENABLED: flag, AUTH_MICROSOFT_ENTRA_ID_ID: "your-app-client-id" })).toBeNull();
    }
  });

  it("derives the issuer from the tenant GUID and asks for no refresh token", () => {
    expect(parseEntraWebConfig({ ...VALID, AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: TENANT.toUpperCase() })).toEqual({
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: "client-secret-value",
      exchangeSecret: VALID.ENTRA_EXCHANGE_SECRET,
      syncManager: false,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      scope: "openid profile email User.Read",
    });
    expect(parseEntraWebConfig({ ...VALID, ENTRA_SYNC_MANAGER: "1" })).toMatchObject({
      syncManager: true,
      scope: "openid profile email User.Read User.Read.All",
    });
  });

  it("refuses a tenant that is no GUID (common, organizations, consumers, domains)", () => {
    for (const tenant of ["common", "organizations", "consumers", "contoso.onmicrosoft.com", "", undefined]) {
      expect(refused({ ...VALID, AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: tenant })).toEqual([
        "AUTH_MICROSOFT_ENTRA_ID_TENANT_ID",
      ]);
    }
  });

  it("refuses a client id that is no GUID, an empty client secret and a short exchange secret", () => {
    expect(refused({ ...VALID, AUTH_MICROSOFT_ENTRA_ID_ID: "your-app-client-id" })).toEqual([
      "AUTH_MICROSOFT_ENTRA_ID_ID",
    ]);
    expect(refused({ ...VALID, AUTH_MICROSOFT_ENTRA_ID_SECRET: " " })).toEqual([
      "AUTH_MICROSOFT_ENTRA_ID_SECRET",
    ]);
    expect(refused({ ...VALID, ENTRA_EXCHANGE_SECRET: "x".repeat(31) })).toEqual(["ENTRA_EXCHANGE_SECRET"]);
    expect(
      refused({ ENTRA_ENABLED: "1", AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: "common" }),
    ).toEqual([
      "AUTH_MICROSOFT_ENTRA_ID_TENANT_ID",
      "AUTH_MICROSOFT_ENTRA_ID_ID",
      "AUTH_MICROSOFT_ENTRA_ID_SECRET",
      "ENTRA_EXCHANGE_SECRET",
    ]);
  });

  it("never puts a value into the error", () => {
    try {
      parseEntraWebConfig({ ...VALID, ENTRA_EXCHANGE_SECRET: "tiny-secret", AUTH_MICROSOFT_ENTRA_ID_ID: "nope-id" });
    } catch (err) {
      expect((err as Error).message).not.toContain("tiny-secret");
      expect((err as Error).message).not.toContain("nope-id");
    }
  });
});

describe("module flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function flags(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const key of [
      "ENTRA_ENABLED",
      "AUTH_LOCAL_ENABLED",
      "LOCAL_REGISTRATION",
      "NEXT_PHASE",
      ...Object.keys(VALID),
    ]) {
      vi.stubEnv(key, env[key]);
    }
    return import("./auth-config");
  }

  it("keeps local sign-in on whenever ENTRA_ENABLED is not '1'", async () => {
    for (const flag of [undefined, "0", "true"]) {
      const mod = await flags({ ...VALID, ENTRA_ENABLED: flag });
      expect([mod.MICROSOFT_ENABLED, mod.LOCAL_ENABLED, mod.ENTRA]).toEqual([false, true, null]);
    }
  });

  it("turns local sign-in off next to Entra unless AUTH_LOCAL_ENABLED=1", async () => {
    const entraOnly = await flags(VALID);
    expect([entraOnly.MICROSOFT_ENABLED, entraOnly.LOCAL_ENABLED]).toEqual([true, false]);
    const both = await flags({ ...VALID, AUTH_LOCAL_ENABLED: "1", LOCAL_REGISTRATION: "1" });
    expect([both.MICROSOFT_ENABLED, both.LOCAL_ENABLED, both.REGISTRATION_ENABLED]).toEqual([true, true, true]);
    const noRegistration = await flags({ ...VALID, LOCAL_REGISTRATION: "1" });
    expect(noRegistration.REGISTRATION_ENABLED).toBe(false);
  });

  it("throws on import for an invalid enabled config, but not during next build", async () => {
    await expect(flags({ ...VALID, AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: "common" })).rejects.toThrow(
      /AUTH_MICROSOFT_ENTRA_ID_TENANT_ID/,
    );
    const build = await flags({
      ...VALID,
      AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: "common",
      NEXT_PHASE: "phase-production-build",
    });
    expect(build.ENTRA).toBeNull();
  });
});

describe("entraLogoutUrl", () => {
  it("builds the tenant's end-session URL with the return address", () => {
    const url = new URL(entraLogoutUrl(TENANT, "https://intranet.example.test/sign-in"));
    expect(`${url.origin}${url.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("https://intranet.example.test/sign-in");
  });
});

describe("sign-in error texts", () => {
  it("exist in English and German for every entra_* code and the generic case", () => {
    for (const key of [...ENTRA_SIGN_IN_ERRORS, "signInFailed"]) {
      expect((en.auth as Record<string, string>)[key], `en ${key}`).toBeTruthy();
      expect((de.auth as Record<string, string>)[key], `de ${key}`).toBeTruthy();
    }
  });
});
