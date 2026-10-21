import { afterEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import {
  parseUserAdminQuery,
  parseUserAdminUpdate,
  updateUser,
  userDetail,
  type UserAdminHost,
} from "./user-admin";

const { bump } = vi.hoisted(() => ({ bump: vi.fn(async () => 2) }));
vi.mock("./document-lock", () => ({ lockDocument: vi.fn(async () => 1) }));
vi.mock("../extensions/users-permissions/strapi-server", () => ({ bumpTokenVersion: bump }));
vi.mock("./audit", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));

const USER = "plugin::users-permissions.user";
const ROLE = "plugin::users-permissions.role";
const ADMIN_ROLE = { id: 1, type: "admin_role" };
const EDITOR_ROLE = { id: 2, type: "editor" };

function world(users: Array<{ id: number } & Record<string, unknown>>) {
  const strapi = createStrapiStub({
    tables: {
      [ROLE]: [ADMIN_ROLE, EDITOR_ROLE],
      [USER]: users.map((user, i) => ({
        documentId: `user${String(i).padStart(20, "0")}`,
        ...user,
      })),
      "api::department.department": [],
    },
  });
  return { strapi, host: strapi as unknown as UserAdminHost };
}

const ENTRA_ENV = {
  ENTRA_ENABLED: "1",
  MS_TENANT_ID: "11111111-1111-1111-1111-111111111111",
  MS_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  ENTRA_EXCHANGE_SECRET: "x".repeat(40),
  ENTRA_SYNC_DEPARTMENT: "1",
  ENTRA_SYNC_MANAGER: "1",
};
afterEach(() => {
  vi.unstubAllEnvs();
  bump.mockClear();
});

describe("user administration rules (v0.23)", () => {
  it("refuses a caller who is no unblocked admin any more under the lock (a queued request)", async () => {
    // Caller 2 passed the request's admin check, then admin 1 demoted them.
    const { host, strapi } = world([
      { id: 1, role: { id: 1 }, blocked: false },
      { id: 2, role: { id: 2 }, blocked: false },
      { id: 3, role: { id: 1 }, blocked: true },
    ]);
    for (const callerId of [2, 3])
      await expect(updateUser(host, callerId, 1, { role: "editor" })).rejects.toMatchObject({
        name: "ForbiddenError",
      });
    expect(strapi.tables[USER][0]).toMatchObject({ role: { id: 1 } });
  });
  it("lets an admin demote another admin while one stays", async () => {
    const { host, strapi } = world([
      { id: 1, role: { id: 1 }, blocked: false },
      { id: 2, role: { id: 1 }, blocked: false },
    ]);
    const detail = await updateUser(host, 1, 2, { role: "editor" });
    expect(detail.role).toBe("editor");
    expect(strapi.tables[USER][1]).toMatchObject({ roleSource: "manual", entraAppliedRole: null });
  });
  it("a block raises the token version once", async () => {
    const { host } = world([
      { id: 1, role: { id: 1 }, blocked: false },
      { id: 3, role: { id: 2 }, blocked: false },
    ]);
    await updateUser(host, 1, 3, { blocked: true });
    expect(bump).toHaveBeenCalledOnce();
    await updateUser(host, 1, 3, { blocked: true });
    expect(bump).toHaveBeenCalledOnce();
  });
  it("refuses department and manager of an Entra-bound user while the sync owns them", async () => {
    for (const [key, value] of Object.entries(ENTRA_ENV)) vi.stubEnv(key, value);
    const { host } = world([
      { id: 1, role: { id: 1 }, blocked: false },
      { id: 2, role: { id: 2 }, entraTenantId: ENTRA_ENV.MS_TENANT_ID },
      { id: 3, role: { id: 2 } },
    ]);
    await expect(updateUser(host, 1, 2, { department: null, manager: null })).rejects.toMatchObject(
      {
        details: { codes: { department: "entraManaged", manager: "entraManaged" } },
      },
    );
    expect((await userDetail(host, 2, 1)).locked).toEqual({ department: true, manager: true });
    // Not bound: nothing locked.
    expect((await userDetail(host, 3, 1)).locked).toEqual({ department: false, manager: false });
    vi.stubEnv("ENTRA_SYNC_MANAGER", "0");
    expect((await userDetail(host, 2, 1)).locked).toEqual({ department: true, manager: false });
  });
});

describe("user administration input (v0.23)", () => {
  it("takes the list's four keys only", () => {
    expect(
      parseUserAdminQuery({ q: "  ada ", role: "editor", blocked: "false", page: "2" }),
    ).toEqual({
      q: "ada",
      role: "editor",
      blocked: "false",
      page: 2,
    });
    for (const bad of [
      { sort: "email" },
      { role: "public" },
      { blocked: "1" },
      { page: "0" },
      { q: "x".repeat(101) },
    ])
      expect(parseUserAdminQuery(bad), JSON.stringify(bad)).toBeNull();
  });
  it("takes exactly role, department, manager and blocked with their types", () => {
    expect(
      parseUserAdminUpdate({
        data: { role: "member", department: null, manager: 7, blocked: false },
      }),
    ).toEqual({ role: "member", department: null, manager: 7, blocked: false });
    for (const data of [
      { email: "x" },
      { role: "authenticated" },
      { manager: "x" },
      { blocked: 1 },
      {},
    ])
      expect(() => parseUserAdminUpdate({ data }), JSON.stringify(data)).toThrow();
    expect(() => parseUserAdminUpdate({})).toThrow();
  });
});
