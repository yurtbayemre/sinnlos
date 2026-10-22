import type { UserAdminDetail, UserAdminListResponse } from "@sinnlos/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ErrorBody } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

const USER = "plugin::users-permissions.user";
const AUDIT = "api::audit-event.audit-event";
type Detail = { data: UserAdminDetail; error?: ErrorBody["error"] };

describe.each(testEngines())("user administration (v0.23) on %s", (engine) => {
  let t: TestStrapi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });
  afterAll(async () => {
    await t?.stop();
  });

  const save = (id: number, data: Record<string, unknown>, caller: "admin_role" = "admin_role") =>
    t.api<Detail>(caller, `/api/user-management/${id}`, { method: "PUT", json: { data } });
  const row = async (id: number) =>
    (await t.strapi.db.query(USER).findOne({
      where: { id },
      populate: { role: true, department: true, manager: true },
    })) as Row;

  it("is admin_role's alone, on every route", async () => {
    const member = t.fixtures.users.member.id;
    for (const caller of [
      "editor",
      "department_head",
      "team_lead",
      "member",
      "guest",
      "authenticated",
      null,
    ] as const) {
      for (const [method, path, json] of [
        ["GET", "/api/user-management", undefined],
        ["GET", `/api/user-management/${member}`, undefined],
        ["PUT", `/api/user-management/${member}`, { data: { blocked: true } }],
        ["POST", `/api/user-management/${member}/role-to-entra`, undefined],
      ] as const) {
        const res = await t.api(caller, path, { method, ...(json ? { json } : {}) });
        expect([401, 403], `${String(caller)} ${method} ${path}`).toContain(res.status);
      }
    }
    expect((await row(member)).blocked).not.toBe(true);
    // The plugin's generic user writes stay closed for everyone, admin_role included.
    for (const caller of ["admin_role", "member", null] as const) {
      expect(
        (await t.api(caller, `/api/users/${member}`, { method: "PUT", json: { blocked: true } }))
          .status,
      ).toBe(403);
      expect(
        (
          await t.api(caller, "/api/users", {
            json: { username: "x", email: "x@example.com", password: "Secret123!" },
          })
        ).status,
      ).toBe(403);
      expect((await t.api(caller, `/api/users/${member}`, { method: "DELETE" })).status).toBe(403);
    }
    expect((await row(member)).blocked).not.toBe(true);
  });

  it("lists by name with search and filters, without a private field", async () => {
    const all = await t.api<UserAdminListResponse>("admin_role", "/api/user-management");
    expect(all.status, all.text).toBe(200);
    expect(all.body.meta).toMatchObject({ page: 1, pageSize: 50 });
    expect(all.body.data.length).toBeGreaterThanOrEqual(7);
    for (const secret of [
      "password",
      "tokenVersion",
      "microsoftOid",
      "resetPasswordToken",
      "confirmationToken",
    ])
      expect(all.text, secret).not.toContain(secret);
    const names = all.body.data.map((user) => user.displayName);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const member = t.fixtures.users.member;
    const found = await t.api<UserAdminListResponse>(
      "admin_role",
      `/api/user-management?q=${encodeURIComponent(member.displayName.toUpperCase())}`,
    );
    expect(found.body.data.map((user) => user.id)).toContain(member.id);
    const editors = await t.api<UserAdminListResponse>(
      "admin_role",
      "/api/user-management?role=editor",
    );
    expect(editors.body.data.every((user) => user.role === "editor")).toBe(true);
    for (const bad of ["?sort=email", "?role=public", "?blocked=yes", "?page=0", "?populate=*"])
      expect((await t.api("admin_role", `/api/user-management${bad}`)).status, bad).toBe(400);
  });

  it("changes a role (manual from then on), a department and a manager; one audit row each", async () => {
    const member = t.fixtures.users.member;
    const before = await t.strapi.db.query(AUDIT).count({ where: { targetUid: USER } });
    const saved = await save(member.id, {
      role: "editor",
      department: t.fixtures.departments.sales.documentId,
      manager: t.fixtures.users.editor.id,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.data).toMatchObject({
      role: "editor",
      roleSource: "manual",
      department: { documentId: t.fixtures.departments.sales.documentId },
      manager: { id: t.fixtures.users.editor.id },
      self: false,
    });
    const stored = await row(member.id);
    expect(stored.roleSource).toBe("manual");
    expect(stored.entraAppliedRole ?? null).toBeNull();
    // The role applies on the member's next request.
    const me = await t.api<{ data?: { role?: { type?: string } } }>("member", "/api/me");
    expect(me.body.data?.role?.type).toBe("editor");
    const audit = (await t.strapi.db.query(AUDIT).findMany({
      where: { targetUid: USER },
      orderBy: { id: "asc" },
    })) as Row[];
    expect(audit.slice(before)).toEqual([
      expect.objectContaining({
        action: "update",
        targetDocumentId: member.documentId,
        actorKind: "user",
        actorUserId: t.fixtures.users.admin_role.id,
        keys: ["department", "manager", "role"],
      }),
    ]);
    const activity = await t.api<{ data: unknown[] }>(
      "admin_role",
      `/api/audit-events?targetUid=${encodeURIComponent(USER)}`,
    );
    expect(activity.status, activity.text).toBe(200);
    expect(activity.body.data.length).toBeGreaterThan(0);
    // Back to the fixture.
    const back = await save(member.id, { role: "member", department: null, manager: null });
    expect(back.status, back.text).toBe(200);
  });

  it("refuses one's own role and blocked state, a manager cycle and unknown fields", async () => {
    const admin = t.fixtures.users.admin_role.id;
    const self = await save(admin, { role: "editor", blocked: true });
    expect(self.status, self.text).toBe(400);
    expect(self.body.error?.details).toMatchObject({
      codes: { role: "selfChange", blocked: "selfChange" },
    });
    const own = await t.api<Detail>("admin_role", `/api/user-management/${admin}`);
    expect(own.body.data).toMatchObject({ self: true, role: "admin_role" });

    const { member, editor } = t.fixtures.users;
    expect((await save(member.id, { manager: editor.id })).status).toBe(200);
    const cycle = await save(editor.id, { manager: member.id });
    expect(cycle.status, cycle.text).toBe(400);
    expect(cycle.body.error?.details).toMatchObject({ codes: { manager: "managerCycle" } });
    const selfManager = await save(editor.id, { manager: editor.id });
    expect(selfManager.body.error?.details).toMatchObject({ codes: { manager: "managerCycle" } });
    expect((await save(member.id, { manager: null })).status).toBe(200);

    for (const data of [
      { email: "x@example.com" },
      { role: "public" },
      { blocked: "yes" },
      { manager: 99999 },
      { department: "zzzzzzzzzzzzzzzzzzzzzzzz" },
      {},
    ]) {
      const res = await save(member.id, data);
      expect(res.status, JSON.stringify(data)).toBe(400);
    }
    expect((await t.api("admin_role", "/api/user-management/99999")).status).toBe(404);
  });

  it("a block ends the sessions at once and old tokens stay dead after an unblock", async () => {
    const guest = t.fixtures.users.guest;
    const old = await t.login(guest.username, guest.password);
    expect((await t.api({ jwt: old }, "/api/me")).status).toBe(200);
    const versionBefore = Number((await row(guest.id)).tokenVersion ?? 0);
    expect((await save(guest.id, { blocked: true })).status).toBe(200);
    expect((await t.api({ jwt: old }, "/api/me")).status).toBe(401);
    expect(Number((await row(guest.id)).tokenVersion ?? 0)).toBeGreaterThan(versionBefore);
    expect((await save(guest.id, { blocked: false })).status).toBe(200);
    expect((await t.api({ jwt: old }, "/api/me")).status).toBe(401);
    const fresh = await t.login(guest.username, guest.password);
    expect((await t.api({ jwt: fresh }, "/api/me")).status).toBe(200);
  });

  it("hands a role back to Entra only for an Entra-bound account, never one's own", async () => {
    const { team_lead: lead, admin_role: admin } = t.fixtures.users;
    const unbound = await t.api<Detail>(
      "admin_role",
      `/api/user-management/${lead.id}/role-to-entra`,
      { method: "POST" },
    );
    expect(unbound.status, unbound.text).toBe(400);
    expect(unbound.body.error?.details).toMatchObject({ codes: { _form: "notEntraBound" } });
    await t.strapi.db.query(USER).update({
      where: { id: lead.id },
      data: { entraTenantId: "11111111-1111-1111-1111-111111111111", roleSource: "manual" },
    });
    const handed = await t.api<Detail>(
      "admin_role",
      `/api/user-management/${lead.id}/role-to-entra`,
      { method: "POST" },
    );
    expect(handed.status, handed.text).toBe(200);
    expect(handed.body.data).toMatchObject({ roleSource: "entra", idp: "entra" });
    expect((await row(lead.id)).entraAppliedRole ?? null).toBeNull();
    const own = await t.api<Detail>(
      "admin_role",
      `/api/user-management/${admin.id}/role-to-entra`,
      {
        method: "POST",
      },
    );
    expect(own.body.error?.details).toMatchObject({ codes: { role: "selfChange" } });
    await t.strapi.db.query(USER).update({
      where: { id: lead.id },
      data: { entraTenantId: null, roleSource: null },
    });
  });
});
