import type { DepartmentEditable, OrgWriteResponse, TeamEditable } from "@sinnlos/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import { storedRevision, type ErrorBody } from "./authoring.test.helper";
import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Params,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";

const DEPT = "api::department.department";
const TEAM = "api::team.team";
const AUDIT = "api::audit-event.audit-event";
type Form = DepartmentEditable | TeamEditable;

describe.each(testEngines())("organisation authoring HTTP on %s", (engine) => {
  let t: TestStrapi;
  let panel: ContentManager;
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    panel = await contentManager(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  const form = (caller: Caller, plural: string, id: string | number, query = "") =>
    t.api<{ data: Form; error?: ErrorBody["error"] }>(
      caller,
      `/api/${plural}/${id}/editable${query}`,
    );
  const save = (
    caller: Caller,
    plural: string,
    id: string | number,
    data: Record<string, unknown>,
    version?: string,
    query = "",
  ) =>
    t.api<OrgWriteResponse & { error?: ErrorBody["error"] }>(
      caller,
      `/api/${plural}/${id}${query}`,
      {
        method: "PUT",
        headers: version === undefined ? {} : { "If-Match": `"${version}"` },
        json: { data },
      },
    );

  for (const kind of ["department", "team"] as const) {
    const uid = `api::${kind}.${kind}`;
    const plural = `${kind}s`;
    const caller = kind === "department" ? "department_head" : "team_lead";
    const target = () =>
      kind === "department" ? t.fixtures.departments.engineering : t.fixtures.teams.platform;
    const media = kind === "department" ? "headerImage" : "avatar";

    it(`${kind}: fixed editable shape, numeric ids and exact grants`, async () => {
      const expected = [
        "documentId",
        "version",
        "updatedAt",
        "name",
        "slug",
        "description",
        "roleClass",
        ...(kind === "department" ? ["color"] : []),
      ].sort();
      for (const id of [target().documentId, target().id]) {
        const res = await form(caller, plural, id);
        expect(res.status, res.text).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(expected);
        expect(res.headers.get("etag")).toBe(`"${res.body.data.version}"`);
        const admin = await form("admin_role", plural, id);
        expect(admin.status, admin.text).toBe(200);
        expect(Object.keys(admin.body.data).sort()).toEqual([...expected, media].sort());
        expect(admin.body.data.roleClass).toBe("moderator");
      }
      for (const denied of [
        "editor",
        "member",
        "guest",
        "authenticated",
        ...(kind === "department" ? (["team_lead"] as const) : []),
      ] as const) {
        expect((await form(denied, plural, target().documentId)).status, denied).toBe(403);
        expect(
          (await save(denied, plural, target().documentId, { description: "Denied" })).status,
          denied,
        ).toBe(403);
      }
      const missing = "zzzzzzzzzzzzzzzzzzzzzzzz";
      expect((await form(caller, plural, missing)).status).toBe(404);
      expect((await save(caller, plural, missing, { description: "Denied" })).status).toBe(403);
    });

    it.each([null, "2026-01-01T00:00:00.000Z"])(
      `${kind}: saves once without status for publishedAt=%s, preserving identity and links`,
      async (publishedAt) => {
        const { documentId, id } = target();
        const relations =
          kind === "department" ? ["head", "members", "teams"] : ["lead", "department", "members"];
        const read = () =>
          t.strapi.db.query(uid).findMany({
            where: { documentId },
            populate: Object.fromEntries(relations.map((key) => [key, { select: ["id"] }])),
          });
        await t.strapi.db.query(uid).update({ where: { documentId }, data: { publishedAt } });
        const before = await read();
        const old = await form(caller, plural, id);
        expect(old.status, old.text).toBe(200);
        const auditBefore = await t.strapi.db
          .query(AUDIT)
          .count({ where: { targetUid: uid, targetDocumentId: documentId } });
        const description = `Saved ${kind} ${String(publishedAt)}`;
        const saved = await save(caller, plural, id, { description }, old.body.data.version);
        expect(saved.status, saved.text).toBe(200);
        expect(saved.body).toEqual({
          data: { documentId, version: String(Number(old.body.data.version) + 1) },
        });
        expect(saved.headers.get("etag")).toBe(`"${saved.body.data.version}"`);
        const after = await read();
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ id, documentId, description });
        for (const field of relations) expect(after[0][field], field).toEqual(before[0][field]);
        const audit = await t.strapi.db.query(AUDIT).findMany({
          where: { targetUid: uid, targetDocumentId: documentId },
          orderBy: { id: "asc" },
        });
        expect(audit.slice(auditBefore)).toEqual([
          expect.objectContaining({
            action: "update",
            keys: ["description"],
            actorKind: "user",
            actorClass: kind === "department" ? "departmentHead" : "teamLead",
            source: "content-api",
            revision: Number(saved.body.data.version),
          }),
        ]);
      },
    );

    it(`${kind}: refuses all query keys, status included, without touching content or revision`, async () => {
      const old = await form(caller, plural, target().documentId);
      for (const query of [
        "?status=draft",
        "?status=published",
        "?populate=*",
        "?fields[0]=name",
        "?filters[name][$eq]=x",
        "?sort=name",
        "?locale=de",
      ]) {
        expect((await form(caller, plural, target().documentId, query)).status, query).toBe(400);
        expect(
          (
            await save(
              caller,
              plural,
              target().documentId,
              { description: "Rejected" },
              old.body.data.version,
              query,
            )
          ).status,
          query,
        ).toBe(400);
      }
      expect((await form(caller, plural, target().documentId)).body).toEqual(old.body);
    });

    it(`${kind}: refuses structural payloads even for admin, and media for row authors`, async () => {
      const old = await form("admin_role", plural, target().documentId);
      for (const key of [
        "name",
        "slug",
        "members",
        "pages",
        "publishedAt",
        "publishAt",
        ...(kind === "department" ? ["head", "teams"] : ["lead", "department"]),
      ]) {
        const res = await save(
          "admin_role",
          plural,
          target().documentId,
          { [key]: null },
          old.body.data.version,
        );
        expect(res.status, `${key}: ${res.text}`).toBe(400);
        expect(res.body.error?.details?.keys).toContain(key);
      }
      for (const role of kind === "department"
        ? (["department_head"] as const)
        : (["department_head", "team_lead"] as const))
        expect(
          (await save(role, plural, target().documentId, { [media]: null }, old.body.data.version))
            .status,
        ).toBe(400);
      expect(await storedRevision(t, uid, target().documentId)).toBe(Number(old.body.data.version));
    });

    it(`${kind}: missing If-Match is 428 and a panel save makes the previous token stale`, async () => {
      const old = await form(caller, plural, target().documentId);
      expect(
        (await save(caller, plural, target().documentId, { description: "Missing token" })).status,
      ).toBe(428);
      const panelSave = await panel.update(uid, target().documentId, {
        description: "Panel change",
      });
      expect(panelSave.status, panelSave.text).toBe(200);
      const stale = await save(
        caller,
        plural,
        target().documentId,
        { description: "Stale" },
        old.body.data.version,
      );
      expect(stale.status, stale.text).toBe(412);
      const current = await form(caller, plural, target().documentId);
      expect(current.body.data.description).toBe("Panel change");
      expect(stale.body.error?.details?.current).toBe(Number(current.body.data.version));
    });

    it(`${kind}: no create/delete route; panel remains available for structural edits`, async () => {
      expect(
        (await t.api("admin_role", `/api/${plural}`, { json: { data: { name: "No API create" } } }))
          .status,
      ).toBe(405);
      expect(
        (await t.api("admin_role", `/api/${plural}/${target().documentId}`, { method: "DELETE" }))
          .status,
      ).toBe(405);
      const created = await panel.create(uid, { name: `Panel ${kind}`, slug: `panel-${kind}` });
      expect([200, 201], created.text).toContain(created.status);
      expect([200, 204]).toContain((await panel.delete(uid, created.body.data.documentId)).status);
    });
  }

  it("department color-only save preserves an unsanitized legacy description byte-for-byte", async () => {
    const target = t.fixtures.departments.engineering;
    const description = "<p>Legacy <b>HTML</b></p>  \n";
    await t.strapi.documents(DEPT).update({ documentId: target.documentId, data: { description } });
    const old = await form("department_head", "departments", target.documentId);
    expect(old.body.data.description).toBe(description);
    const saved = await save(
      "department_head",
      "departments",
      target.documentId,
      { color: "#123456" },
      old.body.data.version,
    );
    expect(saved.status, saved.text).toBe(200);
    expect(
      (await form("department_head", "departments", target.documentId)).body.data.description,
    ).toBe(description);
  });

  it("a head is scoped to current user.department; department.head is display-only", async () => {
    const sales = t.fixtures.departments.sales;
    await t.strapi.documents(DEPT).update({
      documentId: sales.documentId,
      data: { head: t.fixtures.users.department_head.id },
    });
    expect((await form("department_head", "departments", sales.documentId)).status).toBe(404);
    expect(
      (await save("department_head", "departments", sales.documentId, { description: "Denied" }))
        .status,
    ).toBe(403);
  });

  it("team lead precedence stays within the existing role grants", async () => {
    const row = await t.strapi.documents(TEAM).create({
      data: {
        name: "Cross-department lead",
        slug: "cross-department-lead",
        department: t.fixtures.departments.sales.id,
        lead: t.fixtures.users.department_head.id,
      },
    });
    const head = await form("department_head", "teams", row.documentId);
    expect(head.status, head.text).toBe(200);
    expect(head.body.data.roleClass).toBe("teamLead");
    for (const role of ["editor", "member"] as const) {
      await t.strapi
        .documents(TEAM)
        .update({ documentId: row.documentId, data: { lead: t.fixtures.users[role].id } });
      expect((await form(role, "teams", row.documentId)).status).toBe(403);
      expect((await save(role, "teams", row.documentId, { description: "Denied" })).status).toBe(
        403,
      );
    }
  });

  it("a lead lost between gate and lock gets 403 without the newer version", async () => {
    const row = await t.strapi.documents(TEAM).create({
      data: {
        name: "Lost lead",
        slug: "lost-lead",
        department: t.fixtures.departments.engineering.id,
        lead: t.fixtures.users.team_lead.id,
      },
    });
    const old = await form("team_lead", "teams", row.documentId);
    const repository = t.strapi.db.query(TEAM);
    const original = repository.findOne;
    let armed = true;
    repository.findOne = async function (params?: Params): Promise<Row | null> {
      const found = await original.call(this, params);
      if (
        armed &&
        (params?.where as Params)?.documentId === row.documentId &&
        Array.isArray(params?.select) &&
        params.select.includes("description")
      ) {
        armed = false;
        await t.strapi.documents(TEAM).update({ documentId: row.documentId, data: { lead: null } });
      }
      return found;
    };
    try {
      const refused = await save(
        "team_lead",
        "teams",
        row.documentId,
        { description: "Must not save" },
        old.body.data.version,
      );
      expect(refused.status, refused.text).toBe(403);
      expect(refused.body.error).toEqual({
        status: 403,
        name: "PolicyError",
        message: "Policy Failed",
        details: {},
      });
    } finally {
      repository.findOne = original;
    }
    expect(
      (await t.strapi.documents(TEAM).findOne({ documentId: row.documentId }))?.description,
    ).not.toBe("Must not save");
  });
});
