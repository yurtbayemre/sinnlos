import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errors } from "@strapi/utils";
import { afterEach, describe, expect, it } from "vitest";

import auditLifecycles from "../api/audit-event/content-types/audit-event/lifecycles";
import { CONTENT_VERSION_INDEX, indexSql } from "../bootstrap/document-indexes";
import {
  appContentType,
  minimalType,
  openDocumentService,
  type OpenDocumentService,
  type TestMiddleware,
} from "../test/document-service.test.helper";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_KINDS,
  AUDIT_EVENT_UID,
  AUDIT_SOURCES,
  auditRowsFor,
  auditWriteMode,
  changedKeys,
  clip,
  createAuditRecorder,
  recordAuditEvent,
  resolveActor,
  runAsAuditJanitor,
  type AuditHost,
} from "./audit";
import {
  CONTENT_VERSION_UID,
  createDocumentLock,
  runInAuthoringScope,
  type DocumentLockMiddlewareHost,
} from "./document-lock";

/** The content activity trail (decision 06 §H). */

const SCHEMA = JSON.parse(
  readFileSync(
    join(__dirname, "..", "api", "audit-event", "content-types", "audit-event", "schema.json"),
    "utf8",
  ),
) as { attributes: Record<string, { enum?: string[] }> };

const ANNOUNCEMENT = "api::announcement.announcement";

describe("audit-event vocabulary (K4)", () => {
  it("matches the schema's enums", () => {
    expect(SCHEMA.attributes.action.enum).toEqual([...AUDIT_ACTIONS]);
    expect(SCHEMA.attributes.actorKind.enum).toEqual([...AUDIT_ACTOR_KINDS]);
    expect(SCHEMA.attributes.source.enum).toEqual([...AUDIT_SOURCES]);
  });
});

describe("the actor (§H, S12)", () => {
  const request = (strategy: string | undefined, user: unknown) => ({
    requestContext: {
      get: () => ({ state: { auth: strategy ? { strategy: { name: strategy } } : {}, user } }),
    },
  });

  it("users-permissions: the intranet user, content-api", () => {
    expect(
      resolveActor(request("users-permissions", { id: 7 }), { roleClass: "moderator" }),
    ).toEqual({
      actorKind: "user",
      actorUserId: 7,
      actorAdminId: null,
      actorClass: "moderator",
      source: "content-api",
    });
  });

  it("admin: the admin user (C22), admin", () => {
    expect(resolveActor(request("admin", { id: 3 }), undefined)).toEqual({
      actorKind: "admin",
      actorUserId: null,
      actorAdminId: 3,
      actorClass: null,
      source: "admin",
    });
  });

  it("another strategy or none in a request: system, content-api", () => {
    expect(resolveActor(request("api-token", { id: 1 }), undefined)).toMatchObject({
      actorKind: "system",
      source: "content-api",
    });
    expect(resolveActor(request(undefined, undefined), undefined)).toMatchObject({
      actorKind: "system",
      source: "content-api",
    });
  });

  it("no request: system (boot writers), or cron under the scheduler's scope", () => {
    const none = { requestContext: { get: () => undefined } };
    expect(resolveActor(none, undefined)).toMatchObject({ actorKind: "system", source: "system" });
    expect(resolveActor(none, { source: "cron" })).toMatchObject({
      actorKind: "system",
      source: "cron",
    });
    expect(resolveActor({}, undefined)).toMatchObject({ actorKind: "system", source: "system" });
  });
});

describe("rows: keys without values, the mapping", () => {
  it("lists the attribute names a write carried, never values or bookkeeping", () => {
    const attributes = { title: {}, body: {}, publishAt: {} };
    expect(
      changedKeys(
        { body: "secret text", title: "T", updatedBy: 1, documentId: "x", notAnAttribute: 1 },
        attributes,
      ),
    ).toEqual(["body", "title"]);
    expect(changedKeys(undefined, attributes)).toBeNull();
  });

  it("create or update with status published records a publish too", () => {
    const rows = auditRowsFor(
      { action: "update", params: { documentId: "d", status: "published", data: { title: "T" } } },
      { documentId: "d" },
      4,
      false,
    );
    expect(rows.map((row) => [row.action, row.targetDocumentId, row.revision, row.keys])).toEqual([
      ["update", "d", 4, ["title"]],
      ["publish", "d", 4, null],
    ]);
  });

  it("clone records the new document with its source; cron maps publish and unpublish", () => {
    expect(
      auditRowsFor(
        { action: "clone", params: { documentId: "src", data: {} } },
        { documentId: "new" },
        1,
        false,
      ),
    ).toEqual([
      {
        action: "clone",
        targetDocumentId: "new",
        keys: [],
        detail: "cloned from src",
        revision: 1,
      },
    ]);
    expect(
      auditRowsFor({ action: "publish", params: { documentId: "d" } }, {}, 2, true).map(
        (r) => r.action,
      ),
    ).toEqual(["schedulePublish"]);
    expect(
      auditRowsFor({ action: "unpublish", params: { documentId: "d" } }, {}, 2, true).map(
        (r) => r.action,
      ),
    ).toEqual(["scheduleUnpublish"]);
  });

  it("a write that wrote nothing records nothing", () => {
    expect(
      auditRowsFor({ action: "update", params: { documentId: "d", data: {} } }, null, null, false),
    ).toEqual([]);
    expect(auditRowsFor({ action: "findMany", params: {} }, [], null, false)).toEqual([]);
  });

  it("clips long strings to 255 code points without splitting a pair", () => {
    expect(clip("a".repeat(300))?.length).toBe(255);
    const clipped = clip("😀".repeat(300)) ?? "";
    expect(Array.from(clipped)).toHaveLength(255);
    expect(clip(null)).toBeNull();
  });
});

describe("the recorder and the append-only lifecycle (real document service)", () => {
  let open: OpenDocumentService;
  afterEach(async () => {
    await open?.close();
  });

  async function trail() {
    open = await openDocumentService([
      appContentType(CONTENT_VERSION_UID),
      appContentType(AUDIT_EVENT_UID),
      minimalType(ANNOUNCEMENT, "announcements", { title: { type: "string" } }),
    ]);
    await open.db.connection.raw(
      indexSql("sqlite", "main", {
        name: CONTENT_VERSION_INDEX,
        table: "content_versions",
        columns: ["target_uid", "target_document_id"],
        unique: true,
      }),
    );
    (
      open.db as unknown as { lifecycles: { subscribe(subscriber: unknown): void } }
    ).lifecycles.subscribe({
      models: [AUDIT_EVENT_UID],
      ...auditLifecycles,
    });
    const strapi = open.strapi as unknown as DocumentLockMiddlewareHost & AuditHost;
    open.service.use(createDocumentLock(strapi) as TestMiddleware);
    open.service.use(createAuditRecorder(strapi) as TestMiddleware);
    return { docs: open.service(ANNOUNCEMENT), strapi };
  }

  const events = async () =>
    (await open.db.query(AUDIT_EVENT_UID).findMany({ orderBy: { id: "asc" } })).map((row) => ({
      action: row.action,
      targetUid: row.targetUid,
      targetDocumentId: row.targetDocumentId,
      revision: row.revision,
      actorKind: row.actorKind,
      source: row.source,
      actorClass: row.actorClass,
      keys: row.keys,
      detail: row.detail,
    }));

  it("records one row per action with the revision it committed", async () => {
    const { docs } = await trail();
    const created = await docs.create({ data: { title: "v1" } });
    await docs.update({
      documentId: created.documentId,
      data: { title: "v2" },
      status: "published",
    });
    await docs.unpublish({ documentId: created.documentId });
    const cloned = await docs.clone({ documentId: created.documentId, data: { title: "copy" } });
    await docs.findMany({});
    await docs.delete({ documentId: created.documentId });
    const base = {
      targetUid: ANNOUNCEMENT,
      actorKind: "system",
      source: "system",
      actorClass: null,
    };
    expect(await events()).toEqual([
      {
        ...base,
        action: "create",
        targetDocumentId: created.documentId,
        revision: 1,
        keys: ["title"],
        detail: null,
      },
      {
        ...base,
        action: "update",
        targetDocumentId: created.documentId,
        revision: 2,
        keys: ["title"],
        detail: null,
      },
      {
        ...base,
        action: "publish",
        targetDocumentId: created.documentId,
        revision: 2,
        keys: null,
        detail: null,
      },
      {
        ...base,
        action: "unpublish",
        targetDocumentId: created.documentId,
        revision: 3,
        keys: null,
        detail: null,
      },
      {
        ...base,
        action: "clone",
        targetDocumentId: cloned.documentId,
        revision: 1,
        keys: ["title"],
        detail: `cloned from ${created.documentId}`,
      },
      {
        ...base,
        action: "delete",
        targetDocumentId: created.documentId,
        revision: 4,
        keys: null,
        detail: null,
      },
    ]);
  });

  it("takes actorClass and source from the authoring scope", async () => {
    const { docs } = await trail();
    await runInAuthoringScope({ uid: ANNOUNCEMENT, roleClass: "departmentAuthor" }, () =>
      docs.create({ data: { title: "T" } }),
    );
    await runInAuthoringScope({ source: "cron" }, async () => {
      const [row] = await docs.findMany({});
      await docs.publish({ documentId: row.documentId });
    });
    expect((await events()).map((row) => [row.action, row.actorClass, row.source])).toEqual([
      ["create", "departmentAuthor", "system"],
      ["schedulePublish", null, "cron"],
    ]);
  });

  it("a failing insert rolls the change back (nothing catches it)", async () => {
    const { docs } = await trail();
    const created = await docs.create({ data: { title: "v1" } });
    (
      open.db as unknown as { lifecycles: { subscribe(subscriber: unknown): void } }
    ).lifecycles.subscribe({
      models: [AUDIT_EVENT_UID],
      beforeCreate() {
        throw new Error("the audit insert failed");
      },
    });
    await expect(
      docs.update({ documentId: created.documentId, data: { title: "v2" } }),
    ).rejects.toThrow("the audit insert failed");
    expect((await docs.findOne({ documentId: created.documentId }))?.title).toBe("v1");
    expect(await events()).toHaveLength(1);
  });

  it("refuses every write of an audit row except the recorder's create and the janitor's delete", async () => {
    const { strapi } = await trail();
    const query = open.db.query(AUDIT_EVENT_UID);
    const row = {
      action: "create",
      targetUid: ANNOUNCEMENT,
      targetDocumentId: "d",
      actorKind: "system",
      source: "system",
    };
    await expect(query.create({ data: row })).rejects.toThrow(errors.ApplicationError);
    await expect(query.create({ data: row })).rejects.toThrow(/append-only/);
    await recordAuditEvent(strapi, row as never);
    const [stored] = await query.findMany({});
    const asQuery = query as unknown as {
      update(params: unknown): Promise<unknown>;
      updateMany(params: unknown): Promise<unknown>;
      deleteMany(params: unknown): Promise<unknown>;
    };
    await expect(
      asQuery.update({ where: { id: stored.id }, data: { detail: "x" } }),
    ).rejects.toThrow(/append-only/);
    await expect(asQuery.updateMany({ where: {}, data: { detail: "x" } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      runAsAuditJanitor(() => asQuery.update({ where: { id: stored.id }, data: {} })),
    ).rejects.toThrow(/append-only/);
    await expect(query.delete({ where: { id: stored.id } })).rejects.toThrow(/append-only/);
    await expect(asQuery.deleteMany({ where: {} })).rejects.toThrow(/append-only/);
    await expect(runAsAuditJanitor(() => query.create({ data: row }))).rejects.toThrow(
      /append-only/,
    );
    expect(await query.count({})).toBe(1);
    await runAsAuditJanitor(() => asQuery.deleteMany({ where: { id: stored.id } }));
    expect(await query.count({})).toBe(0);
    expect(auditWriteMode()).toBeUndefined();
  });
});
