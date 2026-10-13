import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_ENV,
  adminRequest,
  cmPath,
  contentManager,
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
