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
        // admin_role also reads the structure it manages (v0.22).
        const structure =
          kind === "department"
            ? ["head", "memberCount", "teamCount"]
            : ["department", "lead", "members"];
        expect(Object.keys(admin.body.data).sort()).toEqual(
          [...expected, media, ...structure].sort(),
        );
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

    it(`${kind}: refuses derived/inverse payloads even for admin, structure and media for row authors`, async () => {
      const old = await form("admin_role", plural, target().documentId);
      for (const key of [
        "slug",
        "pages",
        "publishedAt",
        "publishAt",
        ...(kind === "department" ? ["members", "teams"] : []),
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
        for (const key of [
          media,
          "name",
          ...(kind === "department" ? ["head"] : ["lead", "members", "department"]),
        ])
          expect(
            (await save(role, plural, target().documentId, { [key]: null }, old.body.data.version))
              .status,
            `${role} ${key}`,
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

    it(`${kind}: admin_role creates and deletes through the API (v0.22), every other role is refused`, async () => {
      const data =
        kind === "department"
          ? { name: "API Logistik", color: "#00aa00", head: t.fixtures.users.member.documentId }
          : {
              name: "API Lager",
              department: t.fixtures.departments.sales.documentId,
              lead: t.fixtures.users.team_lead.documentId,
              members: {
                connect: [
                  t.fixtures.users.member.documentId,
                  t.fixtures.users.team_lead.documentId,
                ],
              },
            };
      const create = (caller: Caller, json: Record<string, unknown>) =>
        t.api<OrgWriteResponse & { error?: ErrorBody["error"] }>(caller, `/api/${plural}`, {
          json: { data: json },
        });
      for (const denied of [
        "editor",
        "department_head",
        "team_lead",
        "member",
        "guest",
        "authenticated",
      ] as const)
        expect((await create(denied, data)).status, denied).toBe(403);
      expect((await create("admin_role", { ...data, slug: "chosen" })).status).toBe(400);
      if (kind === "team")
        expect((await create("admin_role", { name: "No department" })).status).toBe(400);
      const created = await create("admin_role", data);
      expect(created.status, created.text).toBe(201);
      const { documentId, version } = created.body.data;
      expect(created.headers.get("etag")).toBe(`"${version}"`);
      const rows = await t.strapi.db.query(uid).findMany({
        where: { documentId },
        populate:
          kind === "department" ? { head: true } : { department: true, lead: true, members: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].slug).toMatch(
        new RegExp(`^${kind === "department" ? "api-logistik" : "api-lager"}-[0-9a-f]{8}$`),
      );
      if (kind === "department")
        expect((rows[0].head as Row | null)?.id).toBe(t.fixtures.users.member.id);
      else {
        expect((rows[0].department as Row | null)?.id).toBe(t.fixtures.departments.sales.id);
        expect((rows[0].lead as Row | null)?.id).toBe(t.fixtures.users.team_lead.id);
        expect((rows[0].members as Row[]).map((row) => row.id).sort()).toEqual(
          [t.fixtures.users.member.id, t.fixtures.users.team_lead.id].sort(),
        );
      }
      const remove = (caller: Caller, token?: string) =>
        t.api(caller, `/api/${plural}/${documentId}`, {
          method: "DELETE",
          headers: token === undefined ? {} : { "If-Match": `"${token}"` },
        });
      for (const denied of ["editor", "department_head", "team_lead", "member"] as const)
        expect((await remove(denied, version)).status, denied).toBe(403);
      expect((await remove("admin_role")).status).toBe(428);
      expect((await remove("admin_role", String(Number(version) + 5))).status).toBe(412);
      const removed = await remove("admin_role", version);
      expect(removed.status, removed.text).toBe(204);
      expect(await t.strapi.db.query(uid).count({ where: { documentId } })).toBe(0);
      expect((await remove("admin_role", version)).status).toBe(404);
      const audit = await t.strapi.db.query(AUDIT).findMany({
        where: { targetUid: uid, targetDocumentId: documentId },
        orderBy: { id: "asc" },
      });
      expect(audit.map((row) => [row.action, row.actorClass, row.source])).toEqual([
        ["create", "moderator", "content-api"],
        ["delete", "moderator", "content-api"],
      ]);
      // The panel stays available for repairs.
      const panelRow = await panel.create(uid, { name: `Panel ${kind}`, slug: `panel-${kind}` });
      expect([200, 201], panelRow.text).toContain(panelRow.status);
      expect([200, 204]).toContain((await panel.delete(uid, panelRow.body.data.documentId)).status);
    });
  }

  it("admin renames a department; a taken name answers 400 name/taken without a write", async () => {
    const target = t.fixtures.departments.engineering;
    const old = await form("admin_role", "departments", target.documentId);
    const taken = await save(
      "admin_role",
      "departments",
      target.documentId,
      { name: t.fixtures.departments.sales.name },
      old.body.data.version,
    );
    expect(taken.status, taken.text).toBe(400);
    expect(taken.body.error?.details).toMatchObject({ keys: ["name"], codes: { name: "taken" } });
    // Ignoring case too: Entra's department sync would find both (Codex v0.22).
    const takenCase = await save(
      "admin_role",
      "departments",
      target.documentId,
      { name: String(t.fixtures.departments.sales.name).toUpperCase() },
      old.body.data.version,
    );
    expect(takenCase.status, takenCase.text).toBe(400);
    expect(takenCase.body.error?.details).toMatchObject({ codes: { name: "taken" } });
    // The admin panel passes the same check (the department's beforeCreate; Codex round 4).
    const panelCase = await panel.create(DEPT, {
      name: String(t.fixtures.departments.sales.name).toLowerCase(),
      slug: "panel-sales-lower",
    });
    expect(panelCase.status, panelCase.text).toBe(400);
    // Beyond ASCII too (SQLite's LOWER folds ASCII only; Codex v0.22 round 2).
    const umlaut = await t.api<OrgWriteResponse>("admin_role", "/api/departments", {
      json: { data: { name: "Ärztlicher Dienst" } },
    });
    expect(umlaut.status, umlaut.text).toBe(201);
    const umlautCase = await t.api<OrgWriteResponse & { error?: ErrorBody["error"] }>(
      "admin_role",
      "/api/departments",
      { json: { data: { name: "ärztlicher dienst" } } },
    );
    expect(umlautCase.status, umlautCase.text).toBe(400);
    expect(umlautCase.body.error?.details).toMatchObject({ codes: { name: "taken" } });
    if (engine === "postgres") {
      // Postgres folds per character ("ΟΣ" = "οσ"), JavaScript knows the final sigma ("ος"):
      // the database's folding refuses too, since Entra's $eqi match uses it (Codex round 3).
      const sigma = await t.api<OrgWriteResponse>("admin_role", "/api/departments", {
        json: { data: { name: "ΟΣ" } },
      });
      expect(sigma.status, sigma.text).toBe(201);
      const sigmaCase = await t.api<OrgWriteResponse & { error?: ErrorBody["error"] }>(
        "admin_role",
        "/api/departments",
        { json: { data: { name: "οσ" } } },
      );
      expect(sigmaCase.status, sigmaCase.text).toBe(400);
      expect(
        (
          await t.api("admin_role", `/api/departments/${sigma.body.data.documentId}`, {
            method: "DELETE",
            headers: { "If-Match": `"${sigma.body.data.version}"` },
          })
        ).status,
      ).toBe(204);
    }
    expect(
      (
        await t.api("admin_role", `/api/departments/${umlaut.body.data.documentId}`, {
          method: "DELETE",
          headers: { "If-Match": `"${umlaut.body.data.version}"` },
        })
      ).status,
    ).toBe(204);
    expect(await storedRevision(t, DEPT, target.documentId)).toBe(Number(old.body.data.version));
    const renamed = await save(
      "admin_role",
      "departments",
      target.documentId,
      { name: "IT Engineering (renamed)" },
      old.body.data.version,
    );
    expect(renamed.status, renamed.text).toBe(200);
    const row = await t.strapi.db.query(DEPT).findOne({ where: { documentId: target.documentId } });
    expect(row).toMatchObject({ name: "IT Engineering (renamed)", slug: target.slug });
    const back = await save(
      "admin_role",
      "departments",
      target.documentId,
      { name: old.body.data.name },
      renamed.body.data.version,
    );
    expect(back.status, back.text).toBe(200);
  });

  it("admin changes a team's members and lead by delta; a change made elsewhere meanwhile stays", async () => {
    const target = t.fixtures.teams.platform;
    const old = await form("admin_role", "teams", target.documentId);
    const users = t.fixtures.users;
    const before = ((old.body.data as TeamEditable).members ?? []).map((person) => person.id);
    const refused = await save(
      "admin_role",
      "teams",
      target.documentId,
      { members: { connect: [users.member.documentId, "zzzzzzzzzzzzzzzzzzzzzzzz"] } },
      old.body.data.version,
    );
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.error?.details?.keys).toEqual(["members"]);
    for (const members of [[users.member.documentId], { set: [users.member.documentId] }]) {
      const full = await save(
        "admin_role",
        "teams",
        target.documentId,
        { members },
        old.body.data.version,
      );
      expect(full.status, `${JSON.stringify(members)}: ${full.text}`).toBe(400);
    }
    // Meanwhile the admin panel's user form puts the member into the team
    // (the user's side: no team revision advances).
    await t.strapi.db
      .query("plugin::users-permissions.user")
      .update({ where: { id: users.member.id }, data: { teams: { connect: [target.id] } } });
    const saved = await save(
      "admin_role",
      "teams",
      target.documentId,
      { members: { connect: [users.editor.documentId] }, lead: users.editor.documentId },
      old.body.data.version,
    );
    expect(saved.status, saved.text).toBe(200);
    const after = await form("admin_role", "teams", target.documentId);
    const data = after.body.data as TeamEditable;
    expect(data.lead?.documentId).toBe(users.editor.documentId);
    // The member added elsewhere is still there: the stale form only added the editor.
    expect(data.members?.map((person) => person.id).sort()).toEqual(
      [...new Set([...before, users.member.id, users.editor.id])].sort(),
    );
    const audit = await t.strapi.db.query(AUDIT).findMany({
      where: { targetUid: TEAM, targetDocumentId: target.documentId },
      orderBy: { id: "desc" },
      limit: 1,
    });
    expect(audit[0]).toMatchObject({ action: "update", actorClass: "moderator" });
    expect((audit[0].keys as string[]).sort()).toEqual(["lead", "members"]);
    const removed = await save(
      "admin_role",
      "teams",
      target.documentId,
      {
        // Back to the fixture: drop only who this test added.
        members: {
          disconnect: [users.member, users.editor]
            .filter((user) => !before.includes(user.id))
            .map((user) => user.documentId),
        },
        lead: (old.body.data as TeamEditable).lead?.documentId ?? null,
      },
      saved.body.data.version,
    );
    expect(removed.status, removed.text).toBe(200);
    const restored = (await form("admin_role", "teams", target.documentId)).body
      .data as TeamEditable;
    expect(restored.members?.map((person) => person.id).sort()).toEqual([...before].sort());
  });

  it("one user leading a second team: the first team keeps its lead (no silent move)", async () => {
    const users = t.fixtures.users;
    const created = await t.api<OrgWriteResponse>("admin_role", "/api/teams", {
      json: {
        data: {
          name: "Second lead",
          department: t.fixtures.departments.engineering.documentId,
          lead: users.team_lead.documentId,
        },
      },
    });
    expect(created.status, created.text).toBe(201);
    const platform = await t.strapi.db.query(TEAM).findOne({
      where: { documentId: t.fixtures.teams.platform.documentId },
      populate: { lead: true },
    });
    const second = await t.strapi.db.query(TEAM).findOne({
      where: { documentId: created.body.data.documentId },
      populate: { lead: true },
    });
    expect((second?.lead as Row | null)?.id).toBe(users.team_lead.id);
    expect((platform?.lead as Row | null)?.id).toBe(users.team_lead.id);
  });

  it("deleting a department detaches its people and teams (the hooks run in the transaction)", async () => {
    const users = t.fixtures.users;
    const created = await t.api<OrgWriteResponse>("admin_role", "/api/departments", {
      json: { data: { name: "Short-lived" } },
    });
    expect(created.status, created.text).toBe(201);
    const { documentId, version } = created.body.data;
    const department = await t.strapi.db.query(DEPT).findOne({ where: { documentId } });
    const team = await t.api<OrgWriteResponse>("admin_role", "/api/teams", {
      json: { data: { name: "Short-lived team", department: documentId } },
    });
    expect(team.status, team.text).toBe(201);
    const memberBefore = await t.strapi.db
      .query("plugin::users-permissions.user")
      .findOne({ where: { id: users.member.id }, populate: { department: true } });
    await t.strapi.db
      .query("plugin::users-permissions.user")
      .update({ where: { id: users.member.id }, data: { department: department!.id } });
    const counts = await form("admin_role", "departments", documentId);
    expect(counts.body.data).toMatchObject({ memberCount: 1, teamCount: 1 });
    const removed = await t.api("admin_role", `/api/departments/${documentId}`, {
      method: "DELETE",
      headers: { "If-Match": `"${counts.body.data.version}"` },
    });
    expect(removed.status, removed.text).toBe(204);
    expect(Number(counts.body.data.version)).toBeGreaterThanOrEqual(Number(version));
    const member = await t.strapi.db
      .query("plugin::users-permissions.user")
      .findOne({ where: { id: users.member.id }, populate: { department: true } });
    expect(member?.department ?? null).toBeNull();
    const orphan = await t.strapi.db.query(TEAM).findOne({
      where: { documentId: team.body.data.documentId },
      populate: { department: true },
    });
    expect(orphan?.department ?? null).toBeNull();
    await t.strapi.db.query("plugin::users-permissions.user").update({
      where: { id: users.member.id },
      data: { department: (memberBefore?.department as Row | null)?.id ?? null },
    });
  });

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
