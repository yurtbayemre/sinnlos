import { describe, expect, it, vi } from "vitest";
import type { ActivityListResponse } from "@sinnlos/domain";

import controller from "./audit-event";

vi.mock("@strapi/strapi", () => ({
  factories: { createCoreController: (_uid: string, build: unknown) => build },
}));

const AUDIT = "api::audit-event.audit-event";
const USER = "plugin::users-permissions.user";
const ADMIN = "admin::user";
const stored = (overrides: Record<string, unknown> = {}) => ({
  id: 9,
  createdAt: new Date("2026-10-17T09:00:00Z"),
  action: "update",
  targetUid: "api::course.course",
  targetDocumentId: "gone-course",
  revision: 2,
  actorKind: "user",
  actorUserId: 1,
  actorAdminId: null,
  actorClass: "moderator",
  source: "content-api",
  keys: ["title"],
  detail: null,
  ...overrides,
});

function setup(
  query: Record<string, unknown> = {},
  role: string | null = "admin_role",
  rows = [stored()],
  total = rows.length,
) {
  const events = { count: vi.fn(async () => total), findMany: vi.fn(async () => rows) };
  const users = {
    findMany: vi.fn(async () => [
      { id: 1, displayName: "Intranet user", email: "private@example.test", password: "secret" },
    ]),
  };
  const admins = {
    findMany: vi.fn(async () => [
      {
        id: 1,
        firstname: "Panel",
        lastname: "Admin",
        email: "panel@example.test",
        password: "panel-secret",
      },
    ]),
  };
  const strapi = {
    db: {
      query: vi.fn((uid: string) => ({ [AUDIT]: events, [USER]: users, [ADMIN]: admins })[uid]),
    },
  };
  const ctx = {
    state: { user: role === null ? undefined : { id: 1, role: { type: role } } },
    query,
    unauthorized: vi.fn(),
    forbidden: vi.fn(),
    badRequest: vi.fn(),
    set: vi.fn(),
    send: vi.fn(),
  };
  const actions = (
    controller as unknown as (deps: { strapi: unknown }) => { list(ctx: unknown): Promise<unknown> }
  )({ strapi });
  return {
    ctx,
    strapi,
    events,
    users,
    admins,
    run: () => actions.list(ctx),
    response: () => ctx.send.mock.calls[0][0] as ActivityListResponse,
  };
}

describe("the fixed admin activity read", () => {
  it.each([
    null,
    "editor",
    "department_head",
    "team_lead",
    "member",
    "guest",
    "authenticated",
    "admin",
  ])("refuses %s even when called without its permission gate", async (role) => {
    const t = setup({}, role);
    await t.run();
    expect(role === null ? t.ctx.unauthorized : t.ctx.forbidden).toHaveBeenCalledOnce();
    expect(t.strapi.db.query).not.toHaveBeenCalled();
  });

  it.each([
    { status: "published" },
    { fields: ["detail"] },
    { filters: {} },
    { populate: "*" },
    { sort: "id" },
    { pagination: { pageSize: 1000 } },
    { pageSize: "100" },
    { unknown: "x" },
    { page: "0" },
    { page: "10001" },
    { page: "1.1" },
    { page: "01" },
    { page: "1e2" },
    { page: ["1", "2"] },
    { page: {} },
    { targetUid: "plugin::users-permissions.user" },
    { targetUid: ["api::course.course"] },
    { actorKind: "editor" },
    { actorKind: ["user"] },
    { actorId: "1" },
    { actorKind: "system", actorId: "1" },
    { actorKind: "user", actorId: "0" },
    { actorKind: "admin", actorId: "2147483648" },
    { actorKind: "user", actorId: { $ne: "1" } },
    { actorClass: "admin_role" },
    { actorClass: ["author"] },
    { from: "2026-10-17" },
    { from: "2026-10-17T09:00:00" },
    { from: "2026-02-30T09:00:00Z" },
    { to: ["2026-10-17T09:00:00Z"] },
    { from: "2026-10-17T10:00:00Z", to: "2026-10-17T09:00:00Z" },
  ])("rejects a malformed/unsupported query before reading: %j", async (query) => {
    const t = setup(query);
    await t.run();
    expect(t.ctx.badRequest).toHaveBeenCalledWith("Invalid activity query");
    expect(t.strapi.db.query).not.toHaveBeenCalled();
  });

  it("applies the same bounded filters to count and page, with stable ordering and UTC instants", async () => {
    const t = setup(
      {
        page: "2",
        targetUid: "plugin::upload.file",
        actorKind: "admin",
        actorId: "2147483647",
        actorClass: "moderator",
        from: "2026-10-17T11:00:00+02:00",
        to: "2026-10-17T09:00:00Z",
      },
      "admin_role",
      [],
      26,
    );
    await t.run();
    const where = {
      targetUid: "plugin::upload.file",
      actorKind: "admin",
      actorAdminId: 2147483647,
      actorClass: "moderator",
      createdAt: { $gte: new Date("2026-10-17T09:00:00Z"), $lte: new Date("2026-10-17T09:00:00Z") },
    };
    expect(t.events.count).toHaveBeenCalledWith({ where });
    expect(t.events.findMany).toHaveBeenCalledWith({
      where,
      select: expect.any(Array),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      offset: 25,
      limit: 25,
    });
    expect(t.response().meta.pagination).toEqual({
      page: 2,
      pageSize: 25,
      pageCount: 2,
      total: 26,
    });
    expect(t.ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("projects only event fields and batched actor labels, keeping overlapping user/admin ids separate", async () => {
    const t = setup({}, "admin_role", [
      stored({ email: "event-secret", actor: { password: "hidden" } }),
      stored({ id: 8 }),
      stored({ id: 7, actorKind: "admin", actorAdminId: 1, source: "admin", keys: null }),
      stored({ id: 6, actorUserId: 99 }),
      stored({ id: 5, actorKind: "admin", actorAdminId: 99 }),
      stored({ id: 4, actorKind: "system", actorClass: null, source: "cron" }),
    ]);
    await t.run();
    const response = t.response();
    expect(response.data.map((row) => row.actor)).toEqual([
      { kind: "user", id: 1, displayName: "Intranet user", class: "moderator" },
      { kind: "user", id: 1, displayName: "Intranet user", class: "moderator" },
      { kind: "admin", id: 1, displayName: "Panel Admin", class: "moderator" },
      { kind: "user", id: 99, displayName: "Deleted user #99", class: "moderator" },
      { kind: "admin", id: 99, displayName: "Deleted administrator #99", class: "moderator" },
      { kind: "system", id: null, displayName: "System", class: null },
    ]);
    expect(response.data[0]).toEqual({
      id: 9,
      createdAt: "2026-10-17T09:00:00.000Z",
      action: "update",
      targetUid: "api::course.course",
      targetDocumentId: "gone-course",
      revision: 2,
      source: "content-api",
      keys: ["title"],
      detail: null,
      actor: response.data[0].actor,
    });
    expect(t.users.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { $in: [1, 99] } },
      select: ["id", "displayName"],
      limit: 25,
    });
    expect(t.admins.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { $in: [1, 99] } },
      select: ["id", "firstname", "lastname"],
      limit: 25,
    });
    expect(JSON.stringify(response)).not.toMatch(/email|password|secret/);
    expect(response.data[2].keys).toEqual([]);
  });

  it("returns exact empty/out-of-range metadata without reading rows or actor directories", async () => {
    const t = setup({ page: "10000" }, "admin_role", [], 26);
    await t.run();
    expect(t.response()).toEqual({
      data: [],
      meta: { pagination: { page: 10000, pageSize: 25, pageCount: 2, total: 26 } },
    });
    expect(t.events.findMany).not.toHaveBeenCalled();
    expect(t.users.findMany).not.toHaveBeenCalled();
    expect(t.admins.findMany).not.toHaveBeenCalled();
    const empty = setup({}, "admin_role", [], 0);
    await empty.run();
    expect(empty.response().meta.pagination).toEqual({
      page: 1,
      pageSize: 25,
      pageCount: 1,
      total: 0,
    });
  });

  it("does not turn a failed database read into a successful empty page", async () => {
    const t = setup();
    t.events.count.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(t.run()).rejects.toThrow("database unavailable");
    expect(t.ctx.send).not.toHaveBeenCalled();
  });
});
