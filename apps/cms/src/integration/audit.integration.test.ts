import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActivityListResponse } from "@sinnlos/domain";

import type { AuditEventInput } from "../utils/audit";

import {
  ADMIN_ENV,
  adminRequest,
  cmPath,
  contentManager,
  createUser,
  type ContentManager,
} from "./admin-api.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * The content activity trail (decision 06 §H; batch 15 item 7) on the real
 * cms: the recorder's rows for the admin panel, the scheduler, in-process
 * writers and the content API; a failing insert rolls the change back; the
 * Content Manager lists the rows but cannot change them. `actorClass` for
 * content-API writes is lane 15A's to pin (its gate sets the class).
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const AUDIT = "api::audit-event.audit-event";

interface Scheduler {
  runScheduledPublishing(strapi: unknown, now?: Date): Promise<{ published: string[] }>;
}

describe.each(testEngines())("the audit trail on %s", (engine) => {
  let t: TestStrapi;
  let panel: ContentManager;
  let adminId: number;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    panel = await contentManager(t);
    const admin = await t.strapi.db
      .query("admin::user")
      .findOne({ where: { email: ADMIN_ENV.STRAPI_ADMIN_EMAIL } });
    adminId = admin?.id as number;
  });

  afterAll(async () => {
    await t?.stop();
  });

  const trail = async (documentId: string) =>
    (await t.strapi.db
      .query(AUDIT)
      .findMany({ where: { targetDocumentId: documentId }, orderBy: { id: "asc" } })) as Row[];

  const pick = (rows: Row[]) =>
    rows.map(({ action, actorKind, actorUserId, actorAdminId, source, revision, keys }) => ({
      action,
      actorKind,
      actorUserId,
      actorAdminId,
      source,
      revision,
      keys,
    }));

  it("the admin panel: the admin user, source admin, the keys of the form", async () => {
    const created = await panel.create(ANNOUNCEMENT, {
      title: "Panel",
      body: "secret body",
      audience: "all",
    });
    const documentId = created.body.data.documentId;
    await panel.publish(ANNOUNCEMENT, documentId, { title: "Panel v2" });
    const rows = pick(await trail(documentId));
    const admin = { actorKind: "admin", actorUserId: null, actorAdminId: adminId, source: "admin" };
    expect(rows.map(({ action, revision }) => [action, revision])).toEqual([
      ["create", 1],
      ["update", 2],
      ["publish", 3],
    ]);
    for (const row of rows) expect(row).toMatchObject(admin);
    expect(rows[0].keys).toEqual(expect.arrayContaining(["audience", "body", "title"]));
    // Names, never values.
    expect(JSON.stringify(await trail(documentId))).not.toContain("secret body");
  });

  it("in-process writers outside a request: system / system; the scheduler: schedulePublish / cron", async () => {
    const draft = await t.strapi.documents(ANNOUNCEMENT).create({
      data: {
        title: "Scheduled",
        audience: "all",
        publishAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    await t.requireBuilt<Scheduler>("src/cron/scheduled-publish").runScheduledPublishing(t.strapi);
    expect(pick(await trail(draft.documentId))).toEqual([
      expect.objectContaining({
        action: "create",
        actorKind: "system",
        source: "system",
        revision: 1,
      }),
      expect.objectContaining({
        action: "schedulePublish",
        actorKind: "system",
        source: "cron",
        revision: 2,
      }),
    ]);
  });

  it("the content API: the intranet user, source content-api (a publish row after a create with status published)", async () => {
    const created = await t.api<{ data: { documentId: string } }>(
      "editor",
      "/api/polls?status=published",
      {
        json: { data: { question: "Audited?", options: ["yes", "no"] } },
      },
    );
    expect(created.status, created.text).toBe(201);
    const rows = pick(await trail(created.body.data.documentId));
    expect(rows.map((row) => [row.action, row.actorKind, row.actorUserId, row.source])).toEqual([
      ["create", "user", t.fixtures.users.editor.id, "content-api"],
      ["publish", "user", t.fixtures.users.editor.id, "content-api"],
    ]);
  });

  it("a failing audit insert rolls the change back", async () => {
    const created = await panel.create(ANNOUNCEMENT, { title: "Before", audience: "all" });
    const documentId = created.body.data.documentId;
    const lock = t.requireBuilt<{
      readRevision(s: unknown, u: string, d: string): Promise<number>;
    }>("src/utils/document-lock");
    await t.database.sql("ALTER TABLE audit_events RENAME TO audit_events_away");
    try {
      const failed = await panel.update(ANNOUNCEMENT, documentId, { title: "After" });
      expect(failed.status).toBeGreaterThanOrEqual(400);
      await expect(
        t.strapi.documents(ANNOUNCEMENT).update({ documentId, data: { title: "After" } }),
      ).rejects.toThrow();
    } finally {
      await t.database.sql("ALTER TABLE audit_events_away RENAME TO audit_events");
    }
    const draft = await t.strapi.documents(ANNOUNCEMENT).findOne({ documentId, status: "draft" });
    expect(draft?.title).toBe("Before");
    expect(await lock.readRevision(t.strapi, ANNOUNCEMENT, documentId)).toBe(1);
    expect((await trail(documentId)).map((row) => row.action)).toEqual(["create"]);
  });

  it("only admin_role may read the fixed activity list; generic detail and write routes do not exist", async () => {
    for (const caller of [
      null,
      "editor",
      "department_head",
      "team_lead",
      "member",
      "guest",
      "authenticated",
    ] as const) {
      const response = await t.api(caller, "/api/audit-events");
      expect([401, 403], `${caller}: ${response.text}`).toContain(response.status);
    }
    const response = await t.api<ActivityListResponse>("admin_role", "/api/audit-events");
    expect(response.status, response.text).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const before = await t.strapi.db.query(AUDIT).count();
    for (const [method, path] of [
      ["GET", "/api/audit-events/1"],
      ["POST", "/api/audit-events"],
      ["PUT", "/api/audit-events/1"],
      ["DELETE", "/api/audit-events/1"],
    ]) {
      const refused = await t.api("admin_role", path, { method });
      expect([404, 405], `${method}: ${refused.text}`).toContain(refused.status);
    }
    expect(await t.strapi.db.query(AUDIT).count()).toBe(before);
  });

  it("refuses generic, nested, duplicate, malformed and unbounded activity queries over HTTP", async () => {
    for (const query of [
      "populate=*",
      "fields[0]=actorUserId",
      "filters[action][$eq]=update",
      "sort=id:asc",
      "pagination[pageSize]=1000",
      "status=published",
      "pageSize=100",
      "unknown=x",
      "page=0",
      "page=10001",
      "page=1.5",
      "page=1&page=2",
      "page[x]=1",
      "actorId=1",
      "actorKind=system&actorId=1",
      "actorKind=user&actorId=2147483648",
      "actorKind=user&actorId[$ne]=1",
      "actorKind=editor",
      "actorClass=admin_role",
      "targetUid=plugin::users-permissions.user",
      "from=2026-10-17T09:00:00",
      "from=2026-02-30T09:00:00Z",
      "from=2026-10-18T09:00:00Z&to=2026-10-17T09:00:00Z",
    ]) {
      const response = await t.api("admin_role", `/api/audit-events?${query}`);
      expect(response.status, `${query}: ${response.text}`).toBe(400);
    }
  });

  const activity = async (query: Record<string, string>) => {
    const response = await t.api<ActivityListResponse>(
      "admin_role",
      `/api/audit-events?${new URLSearchParams(query)}`,
    );
    expect(response.status, response.text).toBe(200);
    return response.body;
  };
  const record = async (data: AuditEventInput, at: Date) => {
    await t
      .requireBuilt<{ recordAuditEvent(strapi: unknown, input: AuditEventInput): Promise<void> }>(
        "src/utils/audit",
      )
      .recordAuditEvent(t.strapi, data);
    // Duplicate timestamps are deliberate fixture data; runtime writes remain append-only.
    await t.database.sql("UPDATE audit_events SET created_at = ? WHERE target_document_id = ?", [
      engine === "sqlite" ? at.getTime() : at,
      data.targetDocumentId,
    ]);
    const row = await t.strapi.db
      .query(AUDIT)
      .findOne({ where: { targetDocumentId: data.targetDocumentId } });
    return row!.id;
  };

  it("pages 25 rows with exact filtered counts, stable duplicate-timestamp order and inclusive offset date bounds", async () => {
    const at = new Date("2030-10-17T09:00:00Z");
    const ids: number[] = [];
    for (let i = 0; i < 27; i++)
      ids.push(
        await record(
          {
            action: "delete",
            targetUid: "plugin::upload.file",
            targetDocumentId: `activity-page-${i}`,
            actorKind: "system",
            source: "system",
            detail: `file: ${i}`,
          },
          new Date(at.getTime() + (i === 26 ? 1000 : 0)),
        ),
      );
    const query = {
      targetUid: "plugin::upload.file",
      from: "2030-10-17T11:00:00+02:00",
      to: "2030-10-17T09:00:01Z",
    };
    const first = await activity(query);
    const second = await activity({ ...query, page: "2" });
    const beyond = await activity({ ...query, page: "10000" });
    expect(first.meta.pagination).toEqual({ page: 1, pageSize: 25, pageCount: 2, total: 27 });
    expect(second.meta.pagination).toEqual({ page: 2, pageSize: 25, pageCount: 2, total: 27 });
    expect([...first.data, ...second.data].map((row) => row.id)).toEqual([...ids].reverse());
    expect(first.data).toHaveLength(25);
    expect(second.data).toHaveLength(2);
    expect(beyond.data).toEqual([]);
    expect(beyond.meta.pagination).toEqual({ page: 10000, pageSize: 25, pageCount: 2, total: 27 });
    const exact = await activity({ ...query, to: "2030-10-17T09:00:00Z" });
    expect(exact.meta.pagination.total).toBe(26);
    expect(exact.data.map((row) => row.createdAt)).toEqual(
      Array(25).fill("2030-10-17T09:00:00.000Z"),
    );
    const empty = await activity({ ...query, actorKind: "user" });
    expect(empty).toEqual({
      data: [],
      meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total: 0 } },
    });
  });

  it("keeps user/admin identities separate, labels deleted actors/content and includes system/file/classified events without private objects", async () => {
    const user = await t.strapi.db
      .query("plugin::users-permissions.user")
      .findOne({ where: { id: adminId } });
    expect(user, "fixture ids intentionally overlap").not.toBeNull();
    await t.strapi.db
      .query("admin::user")
      .update({ where: { id: adminId }, data: { firstname: "Panel", lastname: "Operator" } });
    const deletedUser = await createUser(t, "member");
    const deletedAdmin = await t.strapi.db.query("admin::user").create({
      data: {
        firstname: "Former",
        lastname: "Admin",
        email: "former-admin@integration.test",
        isActive: false,
      },
    });
    const at = new Date("2031-10-17T09:00:00Z");
    const events: AuditEventInput[] = [
      {
        action: "delete",
        targetUid: "api::classified.classified",
        targetDocumentId: "activity-user",
        actorKind: "user",
        actorUserId: user!.id,
        actorClass: "author",
        source: "content-api",
        detail: "role: member; title: Deleted classified",
      },
      {
        action: "delete",
        targetUid: "plugin::upload.file",
        targetDocumentId: "activity-admin",
        actorKind: "admin",
        actorAdminId: adminId,
        source: "admin",
        detail: "file: 9; mime: image/png",
      },
      {
        action: "delete",
        targetUid: "api::classified.classified",
        targetDocumentId: "activity-deleted-user",
        actorKind: "user",
        actorUserId: deletedUser.id,
        actorClass: "author",
        source: "content-api",
      },
      {
        action: "delete",
        targetUid: "plugin::upload.file",
        targetDocumentId: "activity-deleted-admin",
        actorKind: "admin",
        actorAdminId: deletedAdmin.id,
        source: "admin",
      },
      {
        action: "schedulePublish",
        targetUid: "api::course.course",
        targetDocumentId: "activity-system",
        actorKind: "system",
        source: "cron",
        revision: 3,
        keys: ["publishAt"],
      },
    ];
    for (const event of events) await record(event, at);
    await t.strapi.db
      .query("plugin::users-permissions.user")
      .delete({ where: { id: deletedUser.id } });
    await t.strapi.db.query("admin::user").delete({ where: { id: deletedAdmin.id } });
    const query = { from: at.toISOString(), to: at.toISOString() };
    const list = await activity(query);
    expect(list.meta.pagination.total).toBe(5);
    const byTarget = new Map(list.data.map((row) => [row.targetDocumentId, row]));
    expect(byTarget.get("activity-user")?.actor).toEqual({
      kind: "user",
      id: user!.id,
      displayName: user!.displayName,
      class: "author",
    });
    expect(byTarget.get("activity-admin")?.actor).toEqual({
      kind: "admin",
      id: adminId,
      displayName: "Panel Operator",
      class: null,
    });
    expect(byTarget.get("activity-deleted-user")?.actor).toEqual({
      kind: "user",
      id: deletedUser.id,
      displayName: `Deleted user #${deletedUser.id}`,
      class: "author",
    });
    expect(byTarget.get("activity-deleted-admin")?.actor).toEqual({
      kind: "admin",
      id: deletedAdmin.id,
      displayName: `Deleted administrator #${deletedAdmin.id}`,
      class: null,
    });
    expect(byTarget.get("activity-system")).toMatchObject({
      source: "cron",
      keys: ["publishAt"],
      actor: { kind: "system", id: null, displayName: "System", class: null },
    });
    expect(JSON.stringify(list)).not.toMatch(
      /email|password|confirmationToken|resetPasswordToken|@integration/,
    );
    for (const row of list.data) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "id",
          "createdAt",
          "action",
          "targetUid",
          "targetDocumentId",
          "revision",
          "source",
          "keys",
          "detail",
          "actor",
        ].sort(),
      );
      expect(Object.keys(row.actor).sort()).toEqual(["kind", "id", "displayName", "class"].sort());
    }
    expect(
      (await activity({ ...query, actorKind: "user", actorId: String(user!.id) })).data.map(
        (row) => row.targetDocumentId,
      ),
    ).toEqual(["activity-user"]);
    expect(
      (await activity({ ...query, actorKind: "admin", actorId: String(adminId) })).data.map(
        (row) => row.targetDocumentId,
      ),
    ).toEqual(["activity-admin"]);
    expect((await activity({ ...query, actorClass: "author" })).meta.pagination.total).toBe(2);
    expect(
      (await activity({ ...query, actorKind: "system" })).data.map((row) => row.targetDocumentId),
    ).toEqual(["activity-system"]);
  });

  it("the Content Manager lists the rows; its create, edit and delete are refused", async () => {
    const created = await panel.create(ANNOUNCEMENT, { title: "Listed", audience: "all" });
    const [row] = await trail(created.body.data.documentId);
    const list = await panel.findOne(AUDIT, row.documentId as string);
    expect(list.status, list.text).toBe(200);
    expect(list.body.data).toMatchObject({
      action: "create",
      targetDocumentId: created.body.data.documentId,
    });

    const edit = await panel.update(AUDIT, row.documentId as string, { detail: "rewritten" });
    expect(edit.status).toBe(400);
    expect(edit.body.error?.message).toMatch(/^Audit events are append-only/);
    const remove = await panel.delete(AUDIT, row.documentId as string);
    expect(remove.status).toBe(400);
    const forged = await panel.create(AUDIT, {
      action: "delete",
      targetUid: ANNOUNCEMENT,
      targetDocumentId: "forged",
      actorKind: "system",
      source: "system",
    });
    expect(forged.status).toBe(400);
    const stored = await t.strapi.db.query(AUDIT).findOne({ where: { id: row.id } });
    expect(stored?.detail).toBeNull();
    expect(await t.strapi.db.query(AUDIT).count({ where: { targetDocumentId: "forged" } })).toBe(0);
    // The list view the panel opens.
    const listing = await adminRequest<{ results: Row[] }>(t, panel.token, cmPath(AUDIT));
    expect(listing.status, listing.text).toBe(200);
    expect(listing.body.results.length).toBeGreaterThan(0);
  });
});
