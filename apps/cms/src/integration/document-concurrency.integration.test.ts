import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";
import { holdTransaction, qualified, settle, waitForLockWait } from "./pg-lock.test.helper";

/**
 * The document revision and its lock (decision 06 §G; batch 15 item 3;
 * spike 7 S7.4 re-run on the version row) on the real cms. Writes run
 * in-process through the Document Service inside the authoring scope that
 * lane 15A's controller will open (the HTTP contract with If-Match is
 * 15A's), and through the admin panel's Content Manager.
 */

const ANNOUNCEMENT = "api::announcement.announcement";

interface Scope {
  uid?: string;
  documentId?: string;
  expectedRevision?: number;
  observedRevision?: number;
  classify?: (target: { uid: string; documentId: string }) => Promise<string | null>;
  committedRevision?: number;
  source?: string;
}

interface DocumentLock {
  runInAuthoringScope<T>(scope: Scope, fn: () => T): T;
  readRevision(strapi: unknown, uid: string, documentId: string): Promise<number>;
}

interface Scheduler {
  runScheduledPublishing(strapi: unknown, now?: Date): Promise<{ published: string[] }>;
}

describe.each(testEngines())("document revisions on %s", (engine) => {
  let t: TestStrapi;
  let panel: ContentManager;
  let lock: DocumentLock;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    panel = await contentManager(t);
    lock = t.requireBuilt<DocumentLock>("src/utils/document-lock");
  });

  afterAll(async () => {
    await t?.stop();
  });

  const docs = () => t.strapi.documents(ANNOUNCEMENT);
  const revision = (documentId: string) => lock.readRevision(t.strapi, ANNOUNCEMENT, documentId);
  const title = async (documentId: string) =>
    (await docs().findOne({ documentId, status: "draft" }))?.title;

  /** A save the way 15A's controller runs it: If-Match as expectedRevision, in a scope. */
  const scopedSave = (documentId: string, token: number, data: Record<string, unknown>) => {
    const scope: Scope = { uid: ANNOUNCEMENT, documentId, expectedRevision: token };
    return lock
      .runInAuthoringScope(scope, () => docs().update({ documentId, data, status: "draft" }))
      .then(() => ({ status: 200, scope }))
      .catch((error: { status?: number; details?: { current?: number } }) => ({
        status: error.status ?? 500,
        current: error.details?.current,
        scope,
      }));
  };

  async function freshAnnouncement(name: string) {
    const created = await docs().create({ data: { title: name, audience: "all" } });
    return created.documentId as string;
  }

  it("S7.4 one token, three writers at once: 200, 412, 412; the winner's title stays", async () => {
    const documentId = await freshAnnouncement("racers");
    const token = await revision(documentId);
    expect(token).toBe(1);
    const results = await Promise.all(
      ["racer A", "racer B", "racer C"].map((name) =>
        scopedSave(documentId, token, { title: name }),
      ),
    );
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 412, 412]);
    for (const result of results.filter((r) => r.status === 412)) {
      expect("current" in result ? result.current : undefined).toBe(2);
    }
    const winner = results.find((result) => result.status === 200);
    expect(winner?.scope.committedRevision).toBe(2);
    expect(["racer A", "racer B", "racer C"]).toContain(await title(documentId));
    expect(await revision(documentId)).toBe(2);
  });

  it("transition versions: publish, unpublish, discard, a scheduler run and a CM save each advance", async () => {
    const documentId = await freshAnnouncement("transitions");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["publish", () => docs().publish({ documentId })],
      ["draft save", () => docs().update({ documentId, data: { title: "changed draft" } })],
      ["discard", () => docs().discardDraft({ documentId })],
      ["unpublish", () => docs().unpublish({ documentId })],
      [
        "scheduler",
        async () => {
          await t.strapi.db.query(ANNOUNCEMENT).update({
            where: { documentId, publishedAt: null },
            data: { publishAt: new Date(Date.now() - 1000) },
          });
          const run = await t
            .requireBuilt<Scheduler>("src/cron/scheduled-publish")
            .runScheduledPublishing(t.strapi);
          expect(run.published).toContain(`${ANNOUNCEMENT} ${documentId}`);
        },
      ],
      ["CM save", () => panel.update(ANNOUNCEMENT, documentId, { title: "panel save" })],
    ];
    for (const [name, step] of steps) {
      const before = await revision(documentId);
      await step();
      // The raw publishAt write above is the test's setup, not a writer (it advances nothing).
      expect(await revision(documentId), name).toBe(before + 1);
      // A form loaded before the step now answers 412 with the new revision.
      const stale = await scopedSave(documentId, before, { title: `after ${name}` });
      expect(stale, name).toMatchObject({ status: 412, current: before + 1 });
    }
  });

  it("a panel save after a scope-carrying save is detected on the next web save", async () => {
    const documentId = await freshAnnouncement("web then panel");
    const first = await scopedSave(documentId, 1, { title: "web v2" });
    expect(first).toMatchObject({ status: 200 });
    const webToken = first.scope.committedRevision as number;
    expect(webToken).toBe(2);
    const cm = await panel.update(ANNOUNCEMENT, documentId, { title: "panel v3" });
    expect(cm.status, cm.text).toBe(200);
    const second = await scopedSave(documentId, webToken, { title: "web v3 over the panel" });
    expect(second).toMatchObject({ status: 412, current: 3 });
    expect(await title(documentId)).toBe("panel v3");
  });

  it("the version row goes with the document; a CM clone starts at 1", async () => {
    const documentId = await freshAnnouncement("to be deleted");
    const cloned = await panel.clone(ANNOUNCEMENT, documentId, { title: "clone" });
    expect(cloned.status, cloned.text).toBe(200);
    expect(await revision(cloned.body.data.documentId)).toBe(1);
    const removed = await panel.delete(ANNOUNCEMENT, documentId);
    expect(removed.status, removed.text).toBe(200);
    expect(await revision(documentId)).toBe(0);
    const rows = await t.strapi.db
      .query("api::content-version.content-version")
      .count({ where: { targetDocumentId: documentId } });
    expect(rows).toBe(0);
  });

  it("an owner department deleted under an admitted scope: the lock re-classifies and answers 404", async () => {
    const DEPARTMENT = "api::department.department";
    const owner = await t.strapi.documents(DEPARTMENT).create({
      data: { name: "IT Owner", slug: "it-owner" },
    });
    const created = await docs().create({
      data: { title: "owned", audience: "all", ownerDepartment: owner.documentId },
    });
    const documentId = created.documentId as string;
    // The gate admitted a department author of IT Owner at this revision.
    const observed = await revision(documentId);
    const classify = async () => {
      const draft = await t.strapi.db.query(ANNOUNCEMENT).findOne({
        where: { documentId, publishedAt: null },
        populate: { ownerDepartment: { select: ["id"] } },
      });
      return (draft?.ownerDepartment as { id?: number } | null)?.id === owner.id
        ? "departmentAuthor"
        : null;
    };
    // The department is deleted in between: the cascade removes the owner
    // link outside the Document Service (this lane does not advance the
    // announcement's revision for it; lane 15D's delete hook does).
    await t.strapi.documents(DEPARTMENT).delete({ documentId: owner.documentId });
    const scope: Scope = {
      uid: ANNOUNCEMENT,
      documentId,
      expectedRevision: observed,
      observedRevision: observed,
      classify,
    };
    const outcome = await lock
      .runInAuthoringScope(scope, () =>
        docs().update({
          documentId,
          data: { title: "written after losing ownership" },
          status: "draft",
        }),
      )
      .then(() => ({ status: 200 }))
      .catch((error: { status?: number }) => ({ status: error.status ?? 500 }));
    expect(outcome).toEqual({ status: 404 });
    expect(await title(documentId)).toBe("owned");
  });

  it.runIf(engine === "postgres")(
    "binding (A2): a save waiting at the lock re-classifies on the committed change: no class → 404, class → 412",
    async () => {
      for (const [classified, expected] of [
        [null, { status: 404 }],
        ["moderator", { status: 412, current: 2 }],
      ] as const) {
        const documentId = await freshAnnouncement(`binding ${String(classified)}`);
        const held = await holdTransaction(t);
        await held.raw(
          `SELECT revision FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
          [ANNOUNCEMENT, documentId],
        );
        // The gate saw revision 1; the client predicts 2.
        const scope: Scope = {
          uid: ANNOUNCEMENT,
          documentId,
          expectedRevision: 2,
          observedRevision: 1,
          classify: async () => classified,
        };
        const save = settle(
          lock.runInAuthoringScope(scope, () =>
            docs().update({
              documentId,
              data: { title: "rides on an old decision" },
              status: "draft",
            }),
          ),
        );
        await waitForLockWait(t);
        // Another writer's change commits in between (a widening, a department delete).
        await held.raw(
          `UPDATE ${qualified(t, "content_versions")} SET revision = revision + 1 WHERE target_uid = ? AND target_document_id = ?`,
          [ANNOUNCEMENT, documentId],
        );
        await held.commit();
        const outcome = await save;
        expect(outcome.ok, String(classified)).toBe(false);
        expect((outcome as { error?: unknown }).error, String(classified)).toMatchObject(expected);
        expect(await title(documentId)).toBe(`binding ${String(classified)}`);
        expect(await revision(documentId)).toBe(2);
      }
    },
  );
});
