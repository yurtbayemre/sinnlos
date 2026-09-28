import { describe, expect, it, vi } from "vitest";
import pluginsConfig from "../../config/plugins";
import { EntraConfigError, parseEntraConfig } from "../entra/config";
import {
  checkEntraConfig,
  nextGrantConfig,
  reportEntraStatus,
  syncAuthProviders,
  type AuthProvidersHost,
  type GrantConfig,
} from "./auth-providers";

/**
 * D-ENTRA-01 spec L / FX44: the users-permissions provider grants on every
 * boot, the Entra config check of register() and the status line; and the
 * plugins.ts half of FX14 (register.allowedFields, no providers block).
 */
const TENANT = "11111111-2222-4333-8444-555555555555";
const ENABLED = {
  ENTRA_ENABLED: "1",
  MS_TENANT_ID: TENANT,
  MS_CLIENT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ENTRA_EXCHANGE_SECRET: "0123456789abcdef0123456789abcdef",
};

/** The grant store as users-permissions keeps it (shortened). */
const storedGrant = (): GrantConfig => ({
  email: { enabled: true, icon: "envelope" },
  microsoft: {
    enabled: true,
    icon: "windows",
    key: "old-client-id",
    secret: "old-client-secret",
    callback: "api/auth/microsoft/callback",
    scope: ["user.read"],
  },
  github: { enabled: false, icon: "github", key: "", secret: "" },
});

function storeHost(initial: unknown) {
  let value = initial;
  const set = vi.fn(async ({ value: next }: { value: GrantConfig }) => {
    value = next;
  });
  const host: AuthProvidersHost = {
    store: vi.fn(() => ({ get: async () => value, set })),
    log: { info: vi.fn() },
  };
  return { host, set, current: () => value };
}

describe("nextGrantConfig", () => {
  it("forces the Microsoft provider off with its key and secret cleared", () => {
    const next = nextGrantConfig(storedGrant(), true);
    expect(next.microsoft).toEqual({
      enabled: false,
      icon: "windows",
      key: "",
      secret: "",
      callback: "api/auth/microsoft/callback",
      scope: ["user.read"],
    });
  });

  it("mirrors local sign-in into grant.email and keeps every other provider", () => {
    expect(nextGrantConfig(storedGrant(), true).email).toEqual({ enabled: true, icon: "envelope" });
    expect(nextGrantConfig(storedGrant(), false).email).toEqual({
      enabled: false,
      icon: "envelope",
    });
    expect(nextGrantConfig(storedGrant(), false).github).toEqual(storedGrant().github);
  });

  it("copes with an empty or foreign store", () => {
    for (const current of [null, undefined, {}]) {
      expect(nextGrantConfig(current, true)).toEqual({
        email: { enabled: true },
        microsoft: { enabled: false, key: "", secret: "" },
      });
    }
  });
});

describe("syncAuthProviders", () => {
  it("Entra off: e-mail on, Microsoft off, one log line, then no writes", async () => {
    const { host, set, current } = storeHost(storedGrant());
    await syncAuthProviders(host, parseEntraConfig({}));
    expect(host.store).toHaveBeenCalledWith({
      type: "plugin",
      name: "users-permissions",
      key: "grant",
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(current()).toMatchObject({
      email: { enabled: true },
      microsoft: { enabled: false, key: "", secret: "" },
    });
    expect(host.log.info).toHaveBeenCalledWith(
      "[bootstrap] users-permissions providers synced (email=on, microsoft=off)",
    );
    await syncAuthProviders(host, parseEntraConfig({}));
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("Entra on: e-mail follows AUTH_LOCAL_ENABLED", async () => {
    const entraOnly = storeHost(storedGrant());
    await syncAuthProviders(entraOnly.host, parseEntraConfig(ENABLED));
    expect(entraOnly.current()).toMatchObject({ email: { enabled: false } });

    const breakGlass = storeHost(storedGrant());
    await syncAuthProviders(
      breakGlass.host,
      parseEntraConfig({ ...ENABLED, AUTH_LOCAL_ENABLED: "1" }),
    );
    expect(breakGlass.current()).toMatchObject({
      email: { enabled: true },
      microsoft: { enabled: false },
    });
  });
});

describe("checkEntraConfig / reportEntraStatus", () => {
  it("throws for an enabled but invalid configuration", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    expect(() => checkEntraConfig(log, { ...ENABLED, MS_TENANT_ID: "common" })).toThrow(
      EntraConfigError,
    );
    expect(() => checkEntraConfig(log, { MS_TENANT_ID: "common" })).not.toThrow();
  });

  it("warns about LOCAL_REGISTRATION=1 next to Entra", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    checkEntraConfig(log, { ...ENABLED, LOCAL_REGISTRATION: "1" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[entra\] LOCAL_REGISTRATION=1/));
  });

  it("logs exactly one status line", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    reportEntraStatus(log, parseEntraConfig({}));
    reportEntraStatus(log, parseEntraConfig(ENABLED));
    expect(log.info.mock.calls).toEqual([
      ["[entra] disabled"],
      [
        `[entra] enabled tenant=${TENANT} mode=dry-run default=member groupRules=0 syncDepartment=0 syncManager=0 ttl=12h local=0`,
      ],
    ]);
  });
});

describe("config/plugins.ts users-permissions (FX14, FX44)", () => {
  const env = Object.assign((key: string, def?: unknown) => (key === "JWT_SECRET" ? "jwt" : def), {
    int: (_key: string, def?: number) => def as number,
    bool: (_key: string, def?: boolean) => def as boolean,
    array: (_key: string, def?: string[]) => def as string[],
  });
  const config = pluginsConfig({ env })["users-permissions"].config as Record<string, unknown>;

  it("lets self-registration set displayName only (no microsoftOid, jobTitle or avatar)", () => {
    expect(config.register).toEqual({ allowedFields: ["displayName"] });
  });

  it("has no providers block (grant.microsoft is forced off at boot instead)", () => {
    expect(config).not.toHaveProperty("providers");
    expect(config.jwt).toEqual({ expiresIn: "7d" });
  });
});
