import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserAdminDetail } from "@sinnlos/domain";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";
import { parseUserListQuery } from "@/lib/loaders/manage/users";
import { buildUserPayload, coerceUserValues, userValuesFromDetail } from "./user-values";

const strapi = vi.fn();
const refresh = vi.fn();
let viewer: Viewer;
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapi(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refresh() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewer }));
const { saveUser, handRoleToEntra } = await import("./user-actions");

const DEPT = "dept00000000000000000001";
const user: UserAdminDetail = {
  id: 12,
  documentId: "user00000000000000000012",
  displayName: "Casey Jones",
  email: "casey@example.test",
  role: "member",
  roleSource: "manual",
  entraBound: false,
  blocked: false,
  department: { documentId: DEPT, name: "Design" },
  manager: { id: 3, displayName: "Riley Kim" },
  teams: [],
  createdAt: null,
  self: false,
  locked: { department: false, manager: false },
};
const initial = userValuesFromDetail(user);
const cmsError = (status: number, details = {}) =>
  new StrapiError(status, "Error", JSON.stringify({ error: { status, details } }));
const body = () => JSON.parse(strapi.mock.calls.at(-1)![1].body).data;

beforeEach(() => {
  viewer = { id: 1, role: "admin_role", displayName: "Alex", department: null };
  strapi.mockReset().mockResolvedValue({ data: user });
  refresh.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("user values (v0.23)", () => {
  it("reads the detail and sends only what changed", () => {
    expect(initial).toEqual({ role: "member", department: DEPT, manager: 3, blocked: false });
    expect(buildUserPayload(initial, initial)).toEqual({});
    expect(
      buildUserPayload({ role: "editor", department: "", manager: null, blocked: true }, initial),
    ).toEqual({ role: "editor", department: null, manager: null, blocked: true });
    // A user without a role keeps "" until a role is picked; "" is never sent.
    expect(buildUserPayload({ ...initial, role: "" }, initial)).toEqual({});
  });
  it("coerces exactly the form's shape", () => {
    expect(coerceUserValues(initial)).toEqual(initial);
    for (const bad of [
      null,
      [],
      { ...initial, role: "public" },
      { ...initial, role: "Admin_role" },
      { ...initial, department: null },
      { ...initial, manager: 0 },
      { ...initial, manager: "3" },
      { ...initial, blocked: "true" },
    ])
      expect(coerceUserValues(bad), JSON.stringify(bad)).toBeNull();
  });
  it("forwards only known list parameters", () => {
    expect(
      parseUserListQuery({ q: "  casey ", role: "editor", blocked: "true", page: "2", x: "1" }),
    ).toEqual({ q: "casey", role: "editor", blocked: "true", page: 2 });
    expect(
      parseUserListQuery({ q: ["a", "b"], role: "public", blocked: "yes", page: "1" }),
    ).toEqual({});
    expect(parseUserListQuery({ q: "x".repeat(300) }).q).toHaveLength(100);
  });
});

describe("user actions (v0.23)", () => {
  it("saves one PUT with only the changed fields and refreshes", async () => {
    await expect(saveUser(12, { ...initial, blocked: true }, initial)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(strapi).toHaveBeenCalledWith(
      "/api/user-management/12",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(body()).toEqual({ blocked: true });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("an unchanged form sends nothing", async () => {
    await expect(saveUser(12, initial, initial)).resolves.toEqual({ ok: true, data: null });
    expect(strapi).not.toHaveBeenCalled();
  });
  it("maps a refusal to the field", async () => {
    strapi.mockRejectedValueOnce(
      cmsError(400, { keys: ["blocked"], codes: { blocked: "lastAdmin" } }),
    );
    await expect(saveUser(12, { ...initial, blocked: true }, initial)).resolves.toMatchObject({
      ok: false,
      code: "invalid",
      fields: { blocked: "lastAdmin" },
    });
  });
  it("hands the role back with one POST", async () => {
    await expect(handRoleToEntra(12)).resolves.toEqual({ ok: true, data: null });
    expect(strapi).toHaveBeenCalledWith(
      "/api/user-management/12/role-to-entra",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it.each(["editor", "department_head", "team_lead", "member", "guest", null])(
    "refuses %s before any request",
    async (role) => {
      viewer.role = role;
      await expect(saveUser(12, { ...initial, blocked: true }, initial)).resolves.toEqual({
        ok: false,
        code: "forbidden",
      });
      await expect(handRoleToEntra(12)).resolves.toEqual({ ok: false, code: "forbidden" });
      expect(strapi).not.toHaveBeenCalled();
    },
  );
  it("refuses a bad id or malformed values before any request", async () => {
    for (const id of [0, -1, 1.5, "12", null])
      await expect(saveUser(id, initial, initial)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    await expect(saveUser(12, { ...initial, role: "public" }, initial)).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    viewer.id = null;
    await expect(handRoleToEntra(12)).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(strapi).not.toHaveBeenCalled();
  });
});
