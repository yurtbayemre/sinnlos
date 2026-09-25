import { beforeEach, describe, expect, it, vi } from "vitest";
import { canCreatePolls, canPostAds, canRsvp, isAdmin } from "./roles";

/**
 * getViewer() (D-SESSION-01): role and department come per request from
 * GET /api/me, never from the session, and every failure fails CLOSED — the
 * role is then null and all role gates deny. A 401 keeps the existing
 * /sign-in?expired=1 redirect (strapi() throws NEXT_REDIRECT, which must
 * escape). `@/lib/strapi`, `@/lib/session`, `@/lib/config` and
 * `next/navigation` are mocked; React's cache() is a pass-through outside a
 * server render, so every call re-resolves.
 */
const state = vi.hoisted(() => ({ demo: false }));
const strapiMock = vi.fn<(path: string) => Promise<unknown>>();
const getSessionMock = vi.fn<() => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({ strapi: (path: string) => strapiMock(path) }));
vi.mock("@/lib/session", () => ({ getSession: () => getSessionMock() }));
vi.mock("@/lib/config", () => ({
  get DEMO_MODE() {
    return state.demo;
  },
}));
vi.mock("next/navigation", () => ({
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e;
  },
}));

const { ANONYMOUS_VIEWER, DEMO_VIEWER, getViewer, toViewer } = await import("./viewer");

/** The FX02 /api/me self-profile shape (apps/cms/src/api/profile). */
const meResponse = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: 7,
    documentId: "user-7",
    username: "ada",
    email: "ada@example.test",
    displayName: "Ada Lovelace",
    role: { id: 4, documentId: "role-4", name: "Editor", type: "editor" },
    department: { id: 3, documentId: "dept-3", name: "Engineering", slug: "engineering" },
    manager: null,
    ...overrides,
  },
});

const denyAll = (role: string | null) => {
  expect(isAdmin(role)).toBe(false);
  expect(canCreatePolls(role)).toBe(false);
  expect(canRsvp(role)).toBe(false);
  expect(canPostAds(role)).toBe(false);
};

beforeEach(() => {
  state.demo = false;
  strapiMock.mockReset();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ user: { id: 7 }, provider: "local" });
});

describe("getViewer", () => {
  it("reads role and department from /api/me (not the session, not /users/me)", async () => {
    strapiMock.mockResolvedValue(meResponse());
    await expect(getViewer()).resolves.toEqual({
      id: 7,
      displayName: "Ada Lovelace",
      role: "editor",
      department: { id: 3, documentId: "dept-3", name: "Engineering", slug: "engineering" },
    });
    expect(strapiMock.mock.calls).toEqual([["/api/me"]]);
  });

  it("resolves a Microsoft session's real role (it used to be undefined)", async () => {
    getSessionMock.mockResolvedValue({ user: { id: 42 }, provider: "microsoft-entra-id" });
    strapiMock.mockResolvedValue(
      meResponse({ id: 42, role: { type: "admin_role" }, department: null }),
    );
    const viewer = await getViewer();
    expect(viewer.role).toBe("admin_role");
    expect(isAdmin(viewer.role)).toBe(true);
  });

  it("is anonymous without a session and never calls Strapi", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(getViewer()).resolves.toEqual(ANONYMOUS_VIEWER);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("fails closed when /api/me errors: role null, every gate denies", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    strapiMock.mockRejectedValue(new Error("Strapi 500 Internal Server Error: boom"));
    const viewer = await getViewer();
    expect(viewer).toEqual(ANONYMOUS_VIEWER);
    denyAll(viewer.role);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it("lets strapi()'s 401 redirect to /sign-in?expired=1 escape", async () => {
    strapiMock.mockRejectedValue(new Error("NEXT_REDIRECT /sign-in?expired=1"));
    await expect(getViewer()).rejects.toThrow("NEXT_REDIRECT /sign-in?expired=1");
  });

  it("serves the demo viewer in DEMO_MODE without a session read or fetch", async () => {
    state.demo = true;
    await expect(getViewer()).resolves.toEqual(DEMO_VIEWER);
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(strapiMock).not.toHaveBeenCalled();
    expect(isAdmin(DEMO_VIEWER.role)).toBe(false);
    expect(canCreatePolls(DEMO_VIEWER.role)).toBe(false);
  });
});

describe("toViewer", () => {
  it("fails closed on payloads without a readable role", () => {
    // What /api/users/me?populate[role] returns for every non-admin caller:
    // users-permissions strips `role` without role.find.
    expect(toViewer(meResponse({ role: undefined }).data).role).toBeNull();
    expect(toViewer(meResponse({ role: null }).data).role).toBeNull();
    expect(toViewer(meResponse({ role: { type: 3 } }).data).role).toBeNull();
    expect(toViewer(meResponse({ role: { type: "" } }).data).role).toBeNull();
    expect(toViewer(meResponse({ role: "admin_role" }).data).role).toBeNull();
  });

  it("is anonymous for anything that is not a user record", () => {
    for (const data of [undefined, null, "user", [], [meResponse().data], { id: "7" }]) {
      expect(toViewer(data)).toEqual(ANONYMOUS_VIEWER);
    }
  });

  it("drops an incomplete department and a non-string display name", () => {
    const viewer = toViewer(
      meResponse({ displayName: 12, department: { id: 3, name: "Engineering" } }).data,
    );
    expect(viewer.displayName).toBeNull();
    expect(viewer.department).toBeNull();
    expect(viewer.role).toBe("editor");
  });

  it("copies only the viewer fields", () => {
    expect(Object.keys(toViewer(meResponse().data)).sort()).toEqual([
      "department",
      "displayName",
      "id",
      "role",
    ]);
  });
});
