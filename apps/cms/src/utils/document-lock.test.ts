import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTENT_VERSION_INDEX, indexSql } from "../bootstrap/document-indexes";
import {
  appContentType,
  minimalType,
  openDocumentService,
  type OpenDocumentService,
  type TestMiddleware,
} from "../test/document-service.test.helper";
import {
  ClassLost,
  CONTENT_VERSION_UID,
  RevisionRequired,
  RevisionStale,
  advanceRevision,
  createDocumentLock,
  etagOf,
  getAuthoringScope,
  lockDocument,
  lockedActionOf,
  parseIfMatch,
  readRevision,
  removeRevision,
  runInAuthoringScope,
  type AuthoringScope,
  type DocumentLockMiddlewareHost,
} from "./document-lock";

/**
 * The document revision and its lock (decision 06 §G; contract K2), on the
 * real document service and query engine (SQLite). Postgres row locks and
 * the concurrent writers are in integration/document-concurrency.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const DEPARTMENT = "api::department.department";
const NOTE = "api::note.note";

let open: OpenDocumentService;
let strapi: DocumentLockMiddlewareHost;

beforeEach(async () => {
  open = await openDocumentService([
    appContentType(CONTENT_VERSION_UID),
    minimalType(ANNOUNCEMENT, "announcements", { title: { type: "string" } }),
    minimalType(DEPARTMENT, "departments", { name: { type: "string" } }, false),
    minimalType(NOTE, "notes", { title: { type: "string" } }),
  ]);
  await open.db.connection.raw(
    indexSql("sqlite", "main", {
      name: CONTENT_VERSION_INDEX,
      table: "content_versions",
      columns: ["target_uid", "target_document_id"],
      unique: true,
    }),
  );
  strapi = open.strapi as unknown as DocumentLockMiddlewareHost;
}, 30_000);

afterEach(async () => {
  await open.close();
});

const versionRows = async () =>
  (await open.db.query(CONTENT_VERSION_UID).findMany({ orderBy: { id: "asc" } })).map((row) => ({
    targetUid: row.targetUid,
    targetDocumentId: row.targetDocumentId,
    revision: row.revision,
  }));

const revisionOf = (documentId: string, uid = ANNOUNCEMENT) =>
  readRevision(strapi, uid, documentId);

const withLock = () => open.service.use(createDocumentLock(strapi) as TestMiddleware);

describe("the revision API", () => {
  it("a document without a row has revision 0, and reading writes nothing", async () => {
    expect(await readRevision(strapi, ANNOUNCEMENT, "doc-a")).toBe(0);
    expect(await versionRows()).toEqual([]);
  });

  it("lockDocument and advanceRevision refuse to run outside a transaction", async () => {
    await expect(lockDocument(strapi, ANNOUNCEMENT, "doc-a")).rejects.toThrow(
      /must run inside a transaction/,
    );
    await expect(advanceRevision(strapi, ANNOUNCEMENT, "doc-a")).rejects.toThrow(
      /must run inside a transaction/,
    );
    await expect(removeRevision(strapi, ANNOUNCEMENT, "doc-a")).rejects.toThrow(
      /must run inside a transaction/,
    );
    expect(await versionRows()).toEqual([]);
  });

  it("lockDocument ensures one row (revision 0); advance raises it; remove deletes it", async () => {
    await open.db.transaction(async () => {
      expect(await lockDocument(strapi, ANNOUNCEMENT, "doc-a")).toBe(0);
      expect(await lockDocument(strapi, ANNOUNCEMENT, "doc-a")).toBe(0);
      expect(await advanceRevision(strapi, ANNOUNCEMENT, "doc-a")).toBe(1);
      expect(await advanceRevision(strapi, ANNOUNCEMENT, "doc-a")).toBe(2);
      // A document of another type with the same documentId is another row.
      expect(await advanceRevision(strapi, NOTE, "doc-a")).toBe(1);
    });
    expect(await versionRows()).toEqual([
      { targetUid: ANNOUNCEMENT, targetDocumentId: "doc-a", revision: 2 },
      { targetUid: NOTE, targetDocumentId: "doc-a", revision: 1 },
    ]);
    await open.db.transaction(() => removeRevision(strapi, ANNOUNCEMENT, "doc-a"));
    expect(await revisionOf("doc-a")).toBe(0);
  });

  it("a rolled-back transaction keeps the old revision", async () => {
    await open.db.transaction(() => advanceRevision(strapi, ANNOUNCEMENT, "doc-a"));
    await expect(
      open.db.transaction(async () => {
        await advanceRevision(strapi, ANNOUNCEMENT, "doc-a");
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await revisionOf("doc-a")).toBe(1);
  });

  it("refuses a missing uid or documentId", async () => {
    await expect(readRevision(strapi, ANNOUNCEMENT, "")).rejects.toThrow(
      /needs a uid and a documentId/,
    );
    await expect(open.db.transaction(() => lockDocument(strapi, "", "doc-a"))).rejects.toThrow(
      /needs a uid and a documentId/,
    );
  });
});

describe("If-Match helpers", () => {
  it("parses a quoted or bare revision and refuses anything else with 428", () => {
    expect(parseIfMatch('"12"')).toBe(12);
    expect(parseIfMatch("7")).toBe(7);
    expect(parseIfMatch(['"3"', '"4"'])).toBe(3);
    for (const bad of [undefined, "", "*", 'W/"3"', '"-1"', '"1.5"', "abc", 5]) {
      expect(() => parseIfMatch(bad), String(bad)).toThrow(RevisionRequired);
    }
    expect(etagOf(12)).toBe('"12"');
  });

  it("the errors carry their status and details", () => {
    expect(new RevisionRequired()).toMatchObject({
      status: 428,
      name: "PreconditionRequiredError",
    });
    expect(new RevisionStale(4)).toMatchObject({
      status: 412,
      name: "PreconditionFailedError",
      current: 4,
      details: { current: 4 },
    });
    expect(new ClassLost(403)).toMatchObject({ status: 403, name: "ForbiddenError" });
    expect(new ClassLost(404)).toMatchObject({ status: 404, name: "NotFoundError" });
  });
});

describe("the middleware: every mutating action advances", () => {
  it("create 1, update 2, publish 3, unpublish 4; reads change nothing", async () => {
    withLock();
    const docs = open.service(ANNOUNCEMENT);
    const created = await docs.create({ data: { title: "v1" } });
    expect(await revisionOf(created.documentId)).toBe(1);
    await docs.update({ documentId: created.documentId, data: { title: "v2" } });
    expect(await revisionOf(created.documentId)).toBe(2);
    await docs.publish({ documentId: created.documentId });
    expect(await revisionOf(created.documentId)).toBe(3);
    await docs.findMany({});
    await docs.findOne({ documentId: created.documentId });
    expect(await revisionOf(created.documentId)).toBe(3);
    await docs.unpublish({ documentId: created.documentId });
    expect(await revisionOf(created.documentId)).toBe(4);
  });

  it("a create with status published is one action: revision 1", async () => {
    withLock();
    const created = await open
      .service(ANNOUNCEMENT)
      .create({ data: { title: "v1" }, status: "published" });
    expect(await revisionOf(created.documentId)).toBe(1);
  });

  it("a discard that keeps the document advances; one that deletes it removes the row (C20)", async () => {
    withLock();
    const docs = open.service(ANNOUNCEMENT);
    const created = await docs.create({ data: { title: "v1" }, status: "published" });
    await docs.update({ documentId: created.documentId, data: { title: "draft change" } });
    await docs.discardDraft({ documentId: created.documentId });
    expect(await revisionOf(created.documentId)).toBe(3);
    await docs.unpublish({ documentId: created.documentId });
    await docs.discardDraft({ documentId: created.documentId });
    expect(await docs.findMany({})).toEqual([]);
    expect(await versionRows()).toEqual([]);
  });

  it("delete removes the row; clone inserts revision 1 for the copy and leaves the source", async () => {
    withLock();
    const docs = open.service(ANNOUNCEMENT);
    const source = await docs.create({ data: { title: "src" } });
    const cloned = await docs.clone({ documentId: source.documentId, data: {} });
    expect(await revisionOf(cloned.documentId)).toBe(1);
    expect(await revisionOf(source.documentId)).toBe(1);
    await docs.delete({ documentId: source.documentId });
    expect(await revisionOf(source.documentId)).toBe(0);
    expect((await versionRows()).map((row) => row.targetDocumentId)).toEqual([cloned.documentId]);
  });

  it("guards single-row types (department) and leaves unguarded types alone", async () => {
    withLock();
    const department = await open.service(DEPARTMENT).create({ data: { name: "D" } });
    await open
      .service(DEPARTMENT)
      .update({ documentId: department.documentId, data: { name: "D2" } });
    expect(await revisionOf(department.documentId, DEPARTMENT)).toBe(2);
    const note = await open.service(NOTE).create({ data: { title: "n" } });
    await open.service(NOTE).update({ documentId: note.documentId, data: { title: "n2" } });
    expect(await revisionOf(note.documentId, NOTE)).toBe(0);
    await open.service(DEPARTMENT).delete({ documentId: department.documentId });
    expect(await versionRows()).toEqual([]);
  });

  it("an update of a missing document leaves no row behind", async () => {
    withLock();
    await open.service(ANNOUNCEMENT).update({ documentId: "missing", data: { title: "x" } });
    expect(await versionRows()).toEqual([]);
  });

  it("refuses a guarded mutation without a documentId", async () => {
    withLock();
    await expect(open.service(ANNOUNCEMENT).update({ data: { title: "x" } })).rejects.toThrow(
      /without a documentId is refused/,
    );
  });

  it("a failing action rolls the advance back with it", async () => {
    withLock();
    const docs = open.service(ANNOUNCEMENT);
    const created = await docs.create({ data: { title: "v1" } });
    open.service.use(async (context, next) => {
      const result = await next();
      if (context.action === "update") throw new Error("inner refusal");
      return result;
    });
    await expect(
      docs.update({ documentId: created.documentId, data: { title: "v2" } }),
    ).rejects.toThrow("inner refusal");
    expect(await revisionOf(created.documentId)).toBe(1);
    expect((await docs.findOne({ documentId: created.documentId }))?.title).toBe("v1");
  });

  it("tells the inner middlewares the revision the action commits", async () => {
    withLock();
    const seen: Array<{ action?: string; revision?: number; documentId?: string }> = [];
    open.service.use(async (context, next) => {
      const before = lockedActionOf(context)?.revision;
      const result = await next();
      seen.push({
        action: context.action,
        revision: before,
        documentId: lockedActionOf(context)?.documentId,
      });
      return result;
    });
    const docs = open.service(ANNOUNCEMENT);
    const created = await docs.create({ data: { title: "v1" } });
    await docs.update({ documentId: created.documentId, data: { title: "v2" } });
    await docs.findMany({});
    expect(seen).toEqual([
      { action: "create", revision: 1, documentId: undefined },
      { action: "update", revision: 2, documentId: created.documentId },
      { action: "findMany", revision: undefined, documentId: undefined },
    ]);
  });
});

describe("the middleware: the authoring scope (§G step 3, amendment row A2)", () => {
  async function seeded() {
    withLock();
    const docs = open.service(ANNOUNCEMENT);
    const created = await docs.create({ data: { title: "v1" } });
    await docs.update({ documentId: created.documentId, data: { title: "v2" } });
    return { docs, documentId: created.documentId as string };
  }

  const scoped = (scope: AuthoringScope, fn: () => Promise<unknown>) =>
    runInAuthoringScope(scope, fn);

  it("accepts the current token, records the committed revision and moves the tokens", async () => {
    const { docs, documentId } = await seeded();
    const scope: AuthoringScope = {
      uid: ANNOUNCEMENT,
      documentId,
      expectedRevision: 2,
      observedRevision: 2,
      classify: async () => "moderator",
      roleClass: "moderator",
    };
    await scoped(scope, async () => {
      expect(getAuthoringScope()).toBe(scope);
      await docs.update({ documentId, data: { title: "v3" } });
    });
    expect(scope).toMatchObject({ committedRevision: 3, expectedRevision: 3, observedRevision: 3 });
    expect(await revisionOf(documentId)).toBe(3);
  });

  it("checks two mutations of one request once, against the client's token", async () => {
    const { docs, documentId } = await seeded();
    const scope: AuthoringScope = { uid: ANNOUNCEMENT, documentId, expectedRevision: 2 };
    await scoped(scope, () =>
      open.db.transaction(async () => {
        await docs.update({ documentId, data: { title: "restored" } });
        await docs.publish({ documentId });
      }),
    );
    expect(scope.committedRevision).toBe(4);
  });

  it("a stale token answers 412 with the current revision and writes nothing", async () => {
    const { docs, documentId } = await seeded();
    const error = await scoped({ uid: ANNOUNCEMENT, documentId, expectedRevision: 1 }, () =>
      docs.update({ documentId, data: { title: "stale" } }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RevisionStale);
    expect(error).toMatchObject({ status: 412, details: { current: 2 } });
    expect((await docs.findOne({ documentId }))?.title).toBe("v2");
    expect(await revisionOf(documentId)).toBe(2);
  });

  it("a mismatch with the class kept answers 412; the classifier ran under the lock", async () => {
    const { docs, documentId } = await seeded();
    const classify = vi.fn(async () => "departmentAuthor");
    const error = await scoped(
      { uid: ANNOUNCEMENT, documentId, expectedRevision: 1, observedRevision: 1, classify },
      () => docs.publish({ documentId }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RevisionStale);
    expect(classify).toHaveBeenCalledWith({ uid: ANNOUNCEMENT, documentId });
  });

  it("a token predicting the next revision after a widening answers 404 and writes nothing", async () => {
    // The gate saw revision 2 (observedRevision) and classified the caller;
    // a moderator's widening then committed revision 3; the client sends
    // the predicted 3. The lock re-classifies on the new rows: no class.
    const { docs, documentId } = await seeded();
    await docs.update({ documentId, data: { title: "widened by a moderator" } });
    const classify = vi.fn(async () => null);
    const error = await scoped(
      { uid: ANNOUNCEMENT, documentId, expectedRevision: 3, observedRevision: 2, classify },
      () => docs.update({ documentId, data: { title: "rides on the old decision" } }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClassLost);
    expect(error).toMatchObject({ status: 404 });
    expect(error).not.toHaveProperty("details.current");
    expect((await docs.findOne({ documentId }))?.title).toBe("widened by a moderator");
    expect(await revisionOf(documentId)).toBe(3);
  });

  it("answers the route's missingClass (403 on generic routes)", async () => {
    const { docs, documentId } = await seeded();
    const error = await scoped(
      {
        uid: ANNOUNCEMENT,
        documentId,
        expectedRevision: 0,
        observedRevision: 0,
        classify: async () => null,
        missingClass: 403,
      },
      () => docs.update({ documentId, data: { title: "x" } }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 403, name: "ForbiddenError" });
  });

  it("compares only the scope's own document; other documents still lock and advance", async () => {
    const { docs, documentId } = await seeded();
    const other = await docs.create({ data: { title: "other" } });
    const scope: AuthoringScope = { uid: ANNOUNCEMENT, documentId, expectedRevision: 2 };
    await scoped(scope, () => docs.update({ documentId: other.documentId, data: { title: "o2" } }));
    expect(await revisionOf(other.documentId)).toBe(2);
    expect(scope.committedRevision).toBeUndefined();
    expect(await revisionOf(documentId)).toBe(2);
  });

  it("a create in a scope binds the scope to the new document at revision 1", async () => {
    withLock();
    const scope: AuthoringScope = { uid: ANNOUNCEMENT, roleClass: "moderator" };
    const created = await scoped(scope, () =>
      open.service(ANNOUNCEMENT).create({ data: { title: "new" } }),
    );
    expect(scope).toMatchObject({
      documentId: (created as { documentId: string }).documentId,
      committedRevision: 1,
    });
  });

  it("a scope with a token but no document is a wiring bug", async () => {
    const { docs, documentId } = await seeded();
    await expect(
      scoped({ expectedRevision: 2 }, () => docs.update({ documentId, data: { title: "x" } })),
    ).rejects.toThrow(/must name its document/);
  });

  it("observedRevision and classify come together or not at all (a half-wired gate is refused)", async () => {
    const { docs, documentId } = await seeded();
    const base = { uid: ANNOUNCEMENT, documentId, expectedRevision: 2 };
    await expect(
      scoped({ ...base, observedRevision: 1 }, () =>
        docs.update({ documentId, data: { title: "x" } }),
      ),
    ).rejects.toThrow(/observedRevision and classify together or neither/);
    await expect(
      scoped({ ...base, classify: async () => "moderator" }, () =>
        docs.update({ documentId, data: { title: "x" } }),
      ),
    ).rejects.toThrow(/observedRevision and classify together or neither/);
    expect((await docs.findOne({ documentId }))?.title).toBe("v2");
  });

  it("without a scope (admin panel, scheduler, generic routes) nothing is compared", async () => {
    const { docs, documentId } = await seeded();
    await scoped({ source: "cron" }, () => docs.publish({ documentId }));
    expect(await revisionOf(documentId)).toBe(3);
  });
});
