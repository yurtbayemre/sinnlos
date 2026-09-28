import { beforeEach, describe, expect, it, vi } from "vitest";
import lifecycle from "./index";

/**
 * The call order of register() and bootstrap() in src/index.ts (roadmap
 * B01: the split must keep it). Every step is mocked and only records its
 * name; the steps themselves are pinned by their own suites
 * (index.register.test.ts wires the real register() hooks).
 */

const { calls, step, failing } = vi.hoisted(() => {
  const calls: string[] = [];
  const failing = new Set<string>();
  const step =
    (name: string) =>
    async (): Promise<void> => {
      calls.push(name);
      if (failing.has(name)) throw new Error(`${name} failed`);
    };
  return { calls, step, failing };
});

vi.mock("./utils/org-dp-guard", () => ({ assertNoOrgDrafts: step("assertNoOrgDrafts") }));
vi.mock("./database/ensure-timestamptz", () => ({
  prepareDatetimeContract: step("prepareDatetimeContract"),
  registerTimestamptzGuard: step("registerTimestamptzGuard"),
  assertTimestamptzContract: step("assertTimestamptzContract"),
}));
vi.mock("./utils/env-guard", () => ({ enforceSecretGuard: step("enforceSecretGuard") }));
vi.mock("./bootstrap/user-contact-sanitizer", () => ({
  registerUserContactSanitizer: step("registerUserContactSanitizer"),
}));
vi.mock("./bootstrap/restricted-relation-guard", () => ({
  registerRestrictedRelationGuard: step("registerRestrictedRelationGuard"),
}));
vi.mock("./utils/poll-audience-guard", () => ({
  registerPollAudienceGuard: step("registerPollAudienceGuard"),
}));
vi.mock("./utils/live-events", () => ({
  registerLiveEventSubscriber: step("registerLiveEventSubscriber"),
}));
vi.mock("./bootstrap/sync-permissions", () => ({
  ensureRoles: step("ensureRoles"),
  syncRolePermissions: step("syncRolePermissions"),
}));
vi.mock("./bootstrap/advanced-settings", () => ({
  syncAdvancedSettings: step("syncAdvancedSettings"),
}));
vi.mock("./utils/poll-audience-backfill", () => ({
  backfillPollAudience: step("backfillPollAudience"),
}));
vi.mock("./utils/admin-seed", () => ({ seedAdminUser: step("seedAdminUser") }));
vi.mock("./digest/send-digests", () => ({ reportDigestConfig: step("reportDigestConfig") }));
vi.mock("./seed-demo", () => ({ seedDemoData: step("seedDemoData") }));
vi.mock("./utils/draft-twins", () => ({ ensureDraftTwins: step("ensureDraftTwins") }));

const strapi = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };

beforeEach(() => {
  calls.length = 0;
  failing.clear();
});

describe("src/index.ts lifecycle order (B01)", () => {
  it("register(): the org draft guard first, the poll audience guard last", async () => {
    await lifecycle.register({ strapi });
    expect(calls).toEqual([
      "assertNoOrgDrafts",
      "prepareDatetimeContract",
      "registerTimestamptzGuard",
      "enforceSecretGuard",
      "registerUserContactSanitizer",
      "registerRestrictedRelationGuard",
      "registerPollAudienceGuard",
    ]);
  });

  it("bootstrap(): roles before the permission sync, the draft twins last", async () => {
    await lifecycle.bootstrap({ strapi });
    expect(calls).toEqual([
      "assertTimestamptzContract",
      "registerLiveEventSubscriber",
      "ensureRoles",
      "syncRolePermissions",
      "syncAdvancedSettings",
      "backfillPollAudience",
      "seedAdminUser",
      "reportDigestConfig",
      "seedDemoData",
      "ensureDraftTwins",
    ]);
  });

  it("a failing permission sync stops the boot before anything after it", async () => {
    failing.add("syncRolePermissions");
    await expect(lifecycle.bootstrap({ strapi })).rejects.toThrow("syncRolePermissions failed");
    expect(calls[calls.length - 1]).toBe("syncRolePermissions");
    expect(calls).not.toContain("syncAdvancedSettings");
  });

  it("a failing org draft guard stops register() before anything else", async () => {
    failing.add("assertNoOrgDrafts");
    await expect(lifecycle.register({ strapi })).rejects.toThrow("assertNoOrgDrafts failed");
    expect(calls).toEqual(["assertNoOrgDrafts"]);
  });
});
