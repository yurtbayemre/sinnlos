import { describe, expect, it } from "vitest";
import { ROLE_PRIVILEGE_ORDER } from "../bootstrap/roles";
import {
  APP_ROLE_TABLE,
  EntraConfigError,
  entraConfigWarnings,
  entraIssuer,
  entraJwksUrl,
  entraStatusLine,
  parseEntraConfig,
  parseGroupRoles,
  parseSessionTtl,
  type Env,
} from "./config";

/**
 * D-ENTRA-01 spec A: ENTRA_ENABLED is the only switch, and an enabled but
 * invalid configuration fails with every bad variable named. Fake GUIDs
 * only (never a real tenant).
 */
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GROUP = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECRET = "0123456789abcdef0123456789abcdef";

const enabled = (env: Env = {}): Env => ({
  ENTRA_ENABLED: "1",
  MS_TENANT_ID: TENANT,
  MS_CLIENT_ID: CLIENT,
  ENTRA_EXCHANGE_SECRET: SECRET,
  ...env,
});

/** The variables an invalid env is refused for. */
function refused(env: Env): string[] {
  try {
    parseEntraConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(EntraConfigError);
    return (err as EntraConfigError).issues.map((issue) => issue.variable);
  }
  throw new Error("expected an EntraConfigError");
}

describe("parseEntraConfig: disabled", () => {
  it("is off unless ENTRA_ENABLED is exactly '1', whatever MS_* holds", () => {
    const placeholders: Env = {
      MS_TENANT_ID: "your-tenant-id",
      MS_CLIENT_ID: "your-app-client-id",
      MS_CLIENT_SECRET: "your-app-client-secret",
      ENTRA_EXCHANGE_SECRET: "short",
      ENTRA_SYNC_MODE: "bogus",
    };
    for (const flag of [undefined, "", "0", "true", "yes", "on", " 1", "1 "]) {
      expect(parseEntraConfig({ ...placeholders, ENTRA_ENABLED: flag })).toEqual({
        enabled: false,
        localEnabled: true,
      });
    }
  });

  it("keeps local sign-in on whenever Entra is off", () => {
    for (const local of [undefined, "0", "1"]) {
      expect(parseEntraConfig({ AUTH_LOCAL_ENABLED: local }).localEnabled).toBe(true);
    }
  });

  it("logs a single disabled status line and no warnings", () => {
    const settings = parseEntraConfig({ LOCAL_REGISTRATION: "1" });
    expect(entraStatusLine(settings)).toBe("[entra] disabled");
    expect(entraConfigWarnings(settings)).toEqual([]);
  });
});

describe("parseEntraConfig: enabled", () => {
  it("applies the defaults of the configuration table", () => {
    expect(parseEntraConfig(enabled())).toEqual({
      enabled: true,
      tenantId: TENANT,
      clientId: CLIENT,
      exchangeSecret: SECRET,
      syncMode: "dry-run",
      defaultRole: "member",
      groupRules: [],
      groupIds: [],
      syncDepartment: false,
      syncManager: false,
      sessionTtl: "12h",
      sessionTtlSeconds: 12 * 3600,
      localEnabled: false,
      localRegistration: false,
    });
  });

  it("stores the GUIDs lower-cased and reads every option", () => {
    const settings = parseEntraConfig(
      enabled({
        MS_TENANT_ID: TENANT.toUpperCase(),
        MS_CLIENT_ID: ` ${CLIENT.toUpperCase()} `,
        ENTRA_SYNC_MODE: "on",
        ENTRA_DEFAULT_ROLE: "deny",
        ENTRA_GROUP_ROLES: `editor:${GROUP(1).toUpperCase()}, member:${GROUP(2)}`,
        ENTRA_SYNC_DEPARTMENT: "1",
        ENTRA_SYNC_MANAGER: "1",
        ENTRA_SESSION_TTL: "7d",
        AUTH_LOCAL_ENABLED: "1",
      }),
    );
    expect(settings).toMatchObject({
      enabled: true,
      tenantId: TENANT,
      clientId: CLIENT,
      syncMode: "on",
      defaultRole: "deny",
      groupRules: [
        { role: "editor", groupId: GROUP(1) },
        { role: "member", groupId: GROUP(2) },
      ],
      groupIds: [GROUP(1), GROUP(2)],
      syncDepartment: true,
      syncManager: true,
      sessionTtl: "7d",
      sessionTtlSeconds: 7 * 86400,
      localEnabled: true,
    });
    expect(entraStatusLine(settings)).toBe(
      `[entra] enabled tenant=${TENANT} mode=on default=deny groupRules=2 syncDepartment=1 syncManager=1 ttl=7d local=1`,
    );
  });

  it.each([
    ["common"],
    ["organizations"],
    ["consumers"],
    ["contoso.onmicrosoft.com"],
    ["example.test"],
    [`${TENANT}0`],
    [TENANT.replace(/-/g, "")],
    [""],
    [undefined],
  ])("refuses MS_TENANT_ID %j", (tenant) => {
    expect(refused(enabled({ MS_TENANT_ID: tenant }))).toEqual(["MS_TENANT_ID"]);
  });

  it.each([["your-app-client-id"], [`${CLIENT}x`], [""], [undefined]])(
    "refuses MS_CLIENT_ID %j",
    (client) => {
      expect(refused(enabled({ MS_CLIENT_ID: client }))).toEqual(["MS_CLIENT_ID"]);
    },
  );

  it("refuses an exchange secret under 32 characters or a template placeholder", () => {
    for (const secret of [undefined, "", "x".repeat(31), ` ${"y".repeat(30)} `]) {
      expect(refused(enabled({ ENTRA_EXCHANGE_SECRET: secret }))).toEqual(["ENTRA_EXCHANGE_SECRET"]);
    }
    expect(refused(enabled({ ENTRA_EXCHANGE_SECRET: `change-me-${"z".repeat(30)}` }))).toEqual([
      "ENTRA_EXCHANGE_SECRET",
    ]);
    expect(parseEntraConfig(enabled({ ENTRA_EXCHANGE_SECRET: "x".repeat(32) })).enabled).toBe(true);
  });

  it("refuses a bad sync mode or default role", () => {
    for (const mode of ["dryrun", "ON", "off", "1"]) {
      expect(refused(enabled({ ENTRA_SYNC_MODE: mode }))).toEqual(["ENTRA_SYNC_MODE"]);
    }
    for (const role of ["admin_role", "editor", "Member", "none"]) {
      expect(refused(enabled({ ENTRA_DEFAULT_ROLE: role }))).toEqual(["ENTRA_DEFAULT_ROLE"]);
    }
    for (const role of ["member", "guest", "deny"]) {
      expect(parseEntraConfig(enabled({ ENTRA_DEFAULT_ROLE: role }))).toMatchObject({
        defaultRole: role,
      });
    }
  });

  it("refuses a malformed ENTRA_SESSION_TTL, zero, or more than 7d", () => {
    for (const ttl of ["12", "12H", "1w", "8d", "169h", "10081m", "0h", "-1h", "1.5h", "h"]) {
      expect(refused(enabled({ ENTRA_SESSION_TTL: ttl })), ttl).toEqual(["ENTRA_SESSION_TTL"]);
    }
    expect(parseEntraConfig(enabled({ ENTRA_SESSION_TTL: "168h" }))).toMatchObject({
      sessionTtlSeconds: 7 * 86400,
    });
  });

  it("refuses ENTRA_GROUP_ROLES with an unknown role, a bad GUID or more than 20 groups", () => {
    expect(refused(enabled({ ENTRA_GROUP_ROLES: `admin:${GROUP(1)}` }))).toEqual([
      "ENTRA_GROUP_ROLES",
    ]);
    expect(refused(enabled({ ENTRA_GROUP_ROLES: "editor:Intranet-Editors" }))).toEqual([
      "ENTRA_GROUP_ROLES",
    ]);
    expect(refused(enabled({ ENTRA_GROUP_ROLES: GROUP(1) }))).toEqual(["ENTRA_GROUP_ROLES"]);
    const many = Array.from({ length: 21 }, (_, i) => `member:${GROUP(i + 1)}`).join(",");
    expect(refused(enabled({ ENTRA_GROUP_ROLES: many }))).toEqual(["ENTRA_GROUP_ROLES"]);
    const twenty = Array.from({ length: 20 }, (_, i) => `member:${GROUP(i + 1)}`).join(",");
    expect(parseEntraConfig(enabled({ ENTRA_GROUP_ROLES: twenty }))).toMatchObject({
      groupIds: expect.arrayContaining([GROUP(1), GROUP(20)]),
    });
  });

  it("names every bad variable at once, and never a value", () => {
    const env = enabled({
      MS_TENANT_ID: "common",
      MS_CLIENT_ID: "nope",
      ENTRA_EXCHANGE_SECRET: "tiny-secret-value",
      ENTRA_SYNC_MODE: "sometimes",
    });
    expect(refused(env)).toEqual([
      "MS_TENANT_ID",
      "MS_CLIENT_ID",
      "ENTRA_EXCHANGE_SECRET",
      "ENTRA_SYNC_MODE",
    ]);
    try {
      parseEntraConfig(env);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/^\[entra\] ENTRA_ENABLED=1, but the Entra configuration is invalid/);
      expect(message).not.toContain("tiny-secret-value");
      expect(message).not.toContain("sometimes");
    }
  });

  it("warns once about LOCAL_REGISTRATION=1 next to Entra", () => {
    expect(entraConfigWarnings(parseEntraConfig(enabled()))).toEqual([]);
    const warnings = entraConfigWarnings(parseEntraConfig(enabled({ LOCAL_REGISTRATION: "1" })));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[entra\] LOCAL_REGISTRATION=1/);
  });
});

describe("helpers", () => {
  it("parses session TTLs", () => {
    expect(parseSessionTtl("30m")).toBe(1800);
    expect(parseSessionTtl("12h")).toBe(43200);
    expect(parseSessionTtl("7d")).toBe(604800);
    expect(parseSessionTtl("8d")).toBeNull();
    expect(parseSessionTtl("")).toBeNull();
  });

  it("lets one group map to several roles and dedupes the group ids", () => {
    const parsed = parseGroupRoles(` editor:${GROUP(1)} ,, admin_role:${GROUP(1)}, editor:${GROUP(1)} `);
    expect(parsed).toEqual({
      ok: true,
      rules: [
        { role: "editor", groupId: GROUP(1) },
        { role: "admin_role", groupId: GROUP(1) },
      ],
      groupIds: [GROUP(1)],
    });
    expect(parseGroupRoles("")).toEqual({ ok: true, rules: [], groupIds: [] });
  });

  it("maps the six fixed app roles onto the six intranet roles", () => {
    expect(Object.values(APP_ROLE_TABLE).sort()).toEqual([...ROLE_PRIVILEGE_ORDER].sort());
    expect(APP_ROLE_TABLE["Intranet.Admin"]).toBe("admin_role");
    expect(APP_ROLE_TABLE["Intranet.Guest"]).toBe("guest");
  });

  it("derives the issuer and the key set from the tenant", () => {
    expect(entraIssuer(TENANT)).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0`);
    expect(entraJwksUrl(TENANT)).toBe(
      `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
    );
  });
});
