/**
 * The v0.27 second-factor gate of the users-permissions extension:
 * mfaDecision (the rev2 gate table + rev3 #6 claim checks), the strategy
 * decorator and the plugin register() wrapper.
 */
import { describe, expect, it, vi } from "vitest";

import {
  decorateStrategy,
  mfaDecision,
  RESTRICTED_ROUTES,
  wrapPluginRegister,
  type AuthStrategy,
} from "./strapi-server";

const ROLES = ["admin_role", "editor"];
const editor = { id: 1, role: { type: "editor" }, totpEnabledAt: null };
const enrolledEditor = { ...editor, totpEnabledAt: "2026-10-23T08:00:00.000Z" };
const member = { id: 2, role: { type: "member" }, totpEnabledAt: null };
const enrolledMember = { ...member, totpEnabledAt: "2026-10-23T08:00:00.000Z" };

describe("mfaDecision", () => {
  it("follows the gate table", () => {
    expect(mfaDecision({ am: "idp" }, editor, ROLES)).toBe("pass");
    expect(mfaDecision({ am: "pw", mfa: 1 }, enrolledEditor, ROLES)).toBe("pass");
    expect(mfaDecision({ am: "pw" }, member, ROLES)).toBe("pass");
    expect(mfaDecision({ am: "pw" }, enrolledEditor, ROLES)).toBe("reauth");
    expect(mfaDecision({ am: "pw" }, enrolledMember, ROLES)).toBe("reauth");
    expect(mfaDecision({ am: "pw" }, editor, ROLES)).toBe("restricted");
    expect(mfaDecision({}, editor, ROLES)).toBe("reauth");
    expect(mfaDecision({}, member, ROLES)).toBe("pass");
    expect(mfaDecision(undefined, member, ROLES)).toBe("pass");
  });

  it("refuses an unknown method or a non-canonical mfa claim", () => {
    expect(mfaDecision({ am: "sso" }, member, ROLES)).toBe("reauth");
    expect(mfaDecision({ am: "pw", mfa: "1" }, member, ROLES)).toBe("reauth");
    expect(mfaDecision({ am: "pw", mfa: true }, enrolledEditor, ROLES)).toBe("reauth");
  });

  it("an empty role list requires nobody (MFA_REQUIRED_ROLES=none)", () => {
    expect(mfaDecision({ am: "pw" }, editor, [])).toBe("pass");
  });
});

describe("decorateStrategy", () => {
  const strategy = (credentials: unknown): AuthStrategy => ({
    name: "users-permissions",
    authenticate: vi.fn(async () => ({ authenticated: true, credentials, ability: {} })),
  });
  const ctx = (method: string, handler: string) => ({
    state: { route: { method, handler } } as Record<string, unknown> & {
      route?: { method?: unknown; handler?: unknown };
    },
  });

  it("passes anonymous and refused results through untouched", async () => {
    const anonymous = { authenticated: true, credentials: null };
    const decorated = decorateStrategy(
      { name: "users-permissions", authenticate: async () => anonymous },
      () => ROLES,
    );
    expect(await decorated.authenticate(ctx("GET", "x"))).toBe(anonymous);
  });

  it("restricts a session without a payload slot to the enrollment routes (fail closed)", async () => {
    // No getToken payload was kept: no claims, so an editor must sign in again.
    const decorated = decorateStrategy(strategy(editor), () => ROLES);
    expect(await decorated.authenticate(ctx("GET", "api::announcement.announcement.find"))).toEqual(
      {
        error: "Invalid credentials",
      },
    );
    const passing = decorateStrategy(strategy(member), () => ROLES);
    const request = ctx("GET", "api::announcement.announcement.find");
    expect(await passing.authenticate(request)).toMatchObject({ authenticated: true });
    expect(request.state.assurance).toEqual({ am: null, mfa: false, tv: 0, restricted: false });
  });

  it("names exactly the profile and enrollment routes as open to a restricted session", () => {
    expect([...RESTRICTED_ROUTES].sort()).toEqual([
      "GET api::profile.profile.me",
      "POST api::profile.profile.mfaActivate",
      "POST api::profile.profile.mfaSetup",
    ]);
  });
});

describe("wrapPluginRegister", () => {
  const authService = () => {
    const registered: { type: string; strategy: { name?: string } }[] = [];
    return {
      registered,
      register(type: string, strategy: { name?: string }) {
        registered.push({ type, strategy });
        return this;
      },
    };
  };

  it("swaps exactly the users-permissions content-api strategy and restores register()", async () => {
    const auth = authService();
    const original = auth.register;
    const plugin = async ({ strapi }: { strapi: { get(name: string): typeof auth } }) => {
      const service = strapi.get("auth");
      service.register("content-api", {
        name: "users-permissions",
        authenticate: async () => ({}),
      } as never);
      service.register("admin", { name: "admin" } as never);
    };
    await wrapPluginRegister(plugin)({ strapi: { get: () => auth } });
    expect(auth.register).toBe(original);
    expect(auth.registered[1].strategy).toEqual({ name: "admin" });
    expect(
      Object.getOwnPropertySymbols(auth.registered[0].strategy).map((s) => s.toString()),
    ).toContain("Symbol(sinnlos.users-permissions.mfa-gate)");
  });

  it("refuses to boot when the plugin registered no such strategy, or two", async () => {
    await expect(
      wrapPluginRegister(async () => undefined)({ strapi: { get: () => authService() } }),
    ).rejects.toThrow("second-factor gate");
    const twice = async ({
      strapi,
    }: {
      strapi: { get(name: string): ReturnType<typeof authService> };
    }) => {
      for (let i = 0; i < 2; i++)
        strapi.get("auth").register("content-api", {
          name: "users-permissions",
          authenticate: async () => ({}),
        } as never);
    };
    await expect(
      wrapPluginRegister(twice)({ strapi: { get: () => authService() } as never }),
    ).rejects.toThrow("second-factor gate");
    expect(() => wrapPluginRegister(undefined)).toThrow("no register()");
  });
});
