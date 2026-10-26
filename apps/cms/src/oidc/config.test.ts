import { describe, expect, it } from "vitest";
import {
  OidcConfigError,
  oidcConfigWarnings,
  oidcStatusLine,
  parseOidcConfig,
  type OidcConfig,
} from "./config";

/** The OIDC configuration (v0.25.0, plan-oidc.md build contract). Made-up URLs and secrets only. */
const VALID = {
  OIDC_ENABLED: "1",
  OIDC_ISSUER: "https://idp.example/realms/intranet",
  OIDC_CLIENT_ID: "sinnlos-web",
  OIDC_EXCHANGE_SECRET: "0123456789abcdef0123456789abcdef",
};

function refused(env: Record<string, string | undefined>): string[] {
  try {
    parseOidcConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(OidcConfigError);
    return (err as OidcConfigError).issues.map((issue) => issue.variable);
  }
  throw new Error("expected an OidcConfigError");
}

const enabled = (env: Record<string, string | undefined>): OidcConfig => {
  const settings = parseOidcConfig(env);
  if (!settings.enabled) throw new Error("expected an enabled configuration");
  return settings;
};

describe("parseOidcConfig", () => {
  it("is off unless OIDC_ENABLED is exactly '1', whatever the other values hold", () => {
    for (const flag of [undefined, "", "0", "true", " 1"]) {
      expect(parseOidcConfig({ OIDC_ENABLED: flag, OIDC_ISSUER: "nonsense" })).toEqual({
        enabled: false,
      });
    }
  });

  it("defaults: roles claim, deny, 12h, no department, no Zitadel, https only", () => {
    expect(enabled(VALID)).toEqual({
      enabled: true,
      issuer: VALID.OIDC_ISSUER,
      clientId: "sinnlos-web",
      exchangeSecret: VALID.OIDC_EXCHANGE_SECRET,
      rolesClaim: ["roles"],
      departmentClaim: null,
      zitadelOrgId: null,
      defaultRole: "deny",
      sessionTtl: "12h",
      sessionTtlSeconds: 12 * 3600,
      allowHttp: false,
      localEnabled: false,
    });
  });

  it("splits claim paths and takes the optional settings", () => {
    const settings = enabled({
      ...VALID,
      OIDC_ROLES_CLAIM: "resource_access.sinnlos-web.roles",
      OIDC_DEPARTMENT_CLAIM: "urn:zitadel:iam:user:metadata.department",
      OIDC_DEFAULT_ROLE: "member",
      OIDC_SESSION_TTL: "8h",
      AUTH_LOCAL_ENABLED: "1",
    });
    expect(settings).toMatchObject({
      rolesClaim: ["resource_access", "sinnlos-web", "roles"],
      departmentClaim: ["urn:zitadel:iam:user:metadata", "department"],
      defaultRole: "member",
      sessionTtlSeconds: 8 * 3600,
      localEnabled: true,
    });
  });

  it("keeps the issuer exactly as written (the trailing slash of authentik)", () => {
    expect(
      enabled({ ...VALID, OIDC_ISSUER: "https://auth.example/application/o/sinnlos/" }).issuer,
    ).toBe("https://auth.example/application/o/sinnlos/");
  });

  it("refuses http unless OIDC_ALLOW_HTTP=1, and an issuer over 255 characters", () => {
    expect(refused({ ...VALID, OIDC_ISSUER: "http://localhost:18080/realms/x" })).toEqual([
      "OIDC_ISSUER",
    ]);
    expect(
      enabled({ ...VALID, OIDC_ISSUER: "http://localhost:18080/realms/x", OIDC_ALLOW_HTTP: "1" })
        .allowHttp,
    ).toBe(true);
    expect(refused({ ...VALID, OIDC_ISSUER: `https://idp.example/${"a".repeat(240)}` })).toEqual([
      "OIDC_ISSUER",
    ]);
    expect(refused({ ...VALID, OIDC_ISSUER: "idp.example" })).toEqual(["OIDC_ISSUER"]);
  });

  it("names every bad variable", () => {
    expect(
      refused({
        OIDC_ENABLED: "1",
        ENTRA_ENABLED: "1",
        OIDC_EXCHANGE_SECRET: "short",
        OIDC_ROLES_CLAIM: "roles..x",
        OIDC_DEPARTMENT_CLAIM: "a b",
        OIDC_ZITADEL_ORG_ID: "org-1",
        OIDC_DEFAULT_ROLE: "admin_role",
        OIDC_SESSION_TTL: "8d",
      }),
    ).toEqual([
      "ENTRA_ENABLED",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_EXCHANGE_SECRET",
      "OIDC_ROLES_CLAIM",
      "OIDC_DEPARTMENT_CLAIM",
      "OIDC_ZITADEL_ORG_ID",
      "OIDC_DEFAULT_ROLE",
      "OIDC_SESSION_TTL",
    ]);
    expect(
      refused({ ...VALID, OIDC_EXCHANGE_SECRET: "change-me-0123456789abcdef0123456789" }),
    ).toEqual(["OIDC_EXCHANGE_SECRET"]);
  });

  it("refuses a Zitadel roles claim without the organisation id (finding 6)", () => {
    const zitadel = { ...VALID, OIDC_ROLES_CLAIM: "urn:zitadel:iam:org:project:roles" };
    expect(refused(zitadel)).toEqual(["OIDC_ZITADEL_ORG_ID"]);
    expect(enabled({ ...zitadel, OIDC_ZITADEL_ORG_ID: "396173383835910147" }).zitadelOrgId).toBe(
      "396173383835910147",
    );
  });

  it("never puts the secret into the error", () => {
    try {
      parseOidcConfig({ ...VALID, OIDC_EXCHANGE_SECRET: "change-me-0123456789abcdef0123456789" });
    } catch (err) {
      expect((err as Error).message).not.toContain("0123456789abcdef");
    }
  });
});

describe("oidcStatusLine / oidcConfigWarnings", () => {
  it("one line, no secret; a warning for http only (registration is gone, v0.32 #189)", () => {
    expect(oidcStatusLine(parseOidcConfig({}))).toBe("[oidc] disabled");
    const line = oidcStatusLine(parseOidcConfig(VALID));
    expect(line).toBe(
      "[oidc] enabled issuer=https://idp.example/realms/intranet default=deny roles=roles department=- zitadelOrg=- ttl=12h http=0 local=0",
    );
    expect(line).not.toContain(VALID.OIDC_EXCHANGE_SECRET);
    expect(oidcConfigWarnings(parseOidcConfig(VALID))).toEqual([]);
    const warnings = oidcConfigWarnings(
      parseOidcConfig({
        ...VALID,
        OIDC_ISSUER: "http://idp.example",
        OIDC_ALLOW_HTTP: "1",
        LOCAL_REGISTRATION: "1",
      }),
    );
    expect(warnings).toEqual([expect.stringMatching(/^\[oidc\] OIDC_ALLOW_HTTP=1/)]);
  });
});
