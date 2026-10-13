import type { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import {
  TEST_ROLES,
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type Row,
  type TestDatabase,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Wiki page history as after-images (decision 06 §J3, DA03; batch 16 lane
 * 16D, contracts K15 and K16) on the real cms, driven in-process (Document
 * Service plus wikiEditContext, as lane 16B's actions will) and through the
 * Content Manager:
 *   - S5.1 a create and an edit record [v1] and [v2] with their editors, a
 *     publish records nothing; S5.7 the anchor holds although every revision
 *     gains a second link row at publish;
 *   - S5.3 an order-only save records nothing, a summary-only save records
 *     the page summary;
 *   - S5.2 a panel save records the admin (adminEditorId), not an editor;
 *   - a discard back to the published content and a panel clone record;
 *   - S5.6 a failing revision insert fails the save, nothing half-written;
 *   - the history module: list, one revision, a restore with restoredFrom
 *     (recorded although unchanged), another page's revision is null;
 *   - no read path for any role, admin_role and editor included;
 *   - a restart after writes: the guard passes, no row lacks published_at;
 *   - the cutover: A → B on the batch-15 lifecycle (a raw before-image of
 *     A), a boot, B → C: B is a baseline and restorable; then a rollback
 *     window (a raw before-image of C, the page set to D raw) and a boot: D
 *     gets a baseline, and the next save that returns to C is recorded.
 */

const PAGE = "api::wiki-page.wiki-page";
const SPACE = "api::wiki-space.wiki-space";
const REVISION = "api::wiki-revision.wiki-revision";

/** A body no read path may ever hand out. */
const SECRET = "ZZREVSECRET";

/** The restart and the cutover boot in their body. */
const BOOT_BUDGET = 180_000;

interface EditContext {
  editorId?: number;
  revisionSummary?: string;
  restoredFrom?: number;
}

interface RevisionDetail {
  id: number;
  kind: "before" | "after" | "baseline";
  title: string | null;
  body: string | null;
  pageSummary: string | null;
  restoredFrom: number | null;
  editor: { id: number; displayName: string } | { admin: true } | null;
}

interface RevisionsModule {
  listRevisions(
    strapi: unknown,
    pageDocumentId: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<{
    results: Array<Omit<RevisionDetail, "body" | "pageSummary">>;
    pagination: { total: number };
  }>;
  getRevision(
    strapi: unknown,
    pageDocumentId: string,
    revisionId: unknown,
  ): Promise<RevisionDetail | null>;
  restoreData(revision: RevisionDetail): Record<string, unknown>;
}

describe.each(testEngines())("wiki revisions as after-images on %s", (engine) => {
  let database: TestDatabase;
  let t: TestStrapi;
  let panel: ContentManager;
  let spaceId: string;
  let memberId: number;
  let editorId: number;

  const boot = async (fixtures: boolean) => {
    t = await createTestStrapi({ database, env: ADMIN_ENV, fixtures });
  };

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    await boot(true);
    panel = await contentManager(t);
    memberId = t.fixtures.users.member.id;
    editorId = t.fixtures.users.editor.id;
    const space = await t.strapi.documents(SPACE).create({
      data: { name: "IT History Space", slug: "it-history-space", visibility: "public" },
      status: "published",
    });
    spaceId = space.documentId;
  });

  afterAll(async () => {
    await t?.stop();
    await database?.drop();
  });

  const docs = (uid: string) => t.strapi.documents(uid);
  const editContext = () =>
    t.requireBuilt<{ wikiEditContext: AsyncLocalStorage<EditContext> }>(
      "src/utils/wiki-edit-context",
    ).wikiEditContext;
  const history = () => t.requireBuilt<RevisionsModule>("src/utils/wiki-revisions");
  const inContext = <T>(context: EditContext, run: () => Promise<T>) =>
    editContext().run(context, run);

  /** The revisions of a page, oldest first. */
  const revisionsOf = async (pageDocumentId: string) =>
    (await t.strapi.db.query(REVISION).findMany({
      where: { pageDocumentId },
      orderBy: { id: "asc" },
      populate: { editor: { select: ["id"] } },
    })) as Row[];

  let slugs = 0;
  const newPage = async (data: Record<string, unknown>, context: EditContext = {}) =>
    inContext(context, () =>
      docs(PAGE).create({
        data: { slug: `it-history-${(slugs += 1)}`, space: spaceId, ...data },
        status: "published",
      }),
    );

  const pageRows = async (documentId: string) =>
    (await t.strapi.db
      .query(PAGE)
      .findMany({ where: { documentId }, orderBy: { id: "asc" } })) as Row[];

  it("S5.1 a create and an edit record [v1] and [v2] with their editors; the publish records nothing", async () => {
    const page = await newPage({ title: "Onboarding", body: "v1" }, { editorId: memberId });
    await inContext({ editorId, revisionSummary: "second" }, () =>
      docs(PAGE).update({ documentId: page.documentId, data: { body: "v2" } }),
    );
    await docs(PAGE).publish({ documentId: page.documentId });
    const rows = await revisionsOf(page.documentId);
    expect(rows.map((row) => [row.kind, row.body, row.summary, row.title])).toEqual([
      ["after", "v1", null, "Onboarding"],
      ["after", "v2", "second", "Onboarding"],
    ]);
    expect(rows.map((row) => (row.editor as { id: number } | null)?.id)).toEqual([
      memberId,
      editorId,
    ]);
    for (const row of rows) expect(row.publishedAt).not.toBeNull();
  });

  it("S5.7 the anchor holds although every revision gains a link to the published page row", async () => {
    const page = await newPage({ title: "Anchored", body: "a1" });
    await docs(PAGE).update({ documentId: page.documentId, data: { body: "a2" } });
    await docs(PAGE).publish({ documentId: page.documentId });
    const rows = await revisionsOf(page.documentId);
    const [first] = rows;
    const linked = (await t.strapi.db.query(REVISION).findOne({
      where: { id: first.id },
      populate: { page: { select: ["id"] } },
    })) as Row;
    expect(linked.page).toBeTruthy();
    const list = await history().listRevisions(t.strapi, page.documentId);
    expect(list.pagination.total).toBe(rows.length);
    expect(list.results.map((entry) => entry.id)).toEqual(rows.map((row) => row.id).reverse());
  });

  it("S5.3 an order-only save records nothing; a summary-only save records the page summary", async () => {
    const page = await newPage({ title: "Ordered", body: "o1", summary: "first" });
    await docs(PAGE).update({ documentId: page.documentId, data: { order: 7 } });
    expect(await revisionsOf(page.documentId)).toHaveLength(1);
    await docs(PAGE).update({ documentId: page.documentId, data: { summary: "second" } });
    const rows = await revisionsOf(page.documentId);
    expect(rows.map((row) => [row.body, row.pageSummary])).toEqual([
      ["o1", "first"],
      ["o1", "second"],
    ]);
  });

  it("S5.2 a panel save records the admin, not an editor; the panel publish records nothing", async () => {
    const page = await newPage({ title: "Panel", body: "p1" });
    const saved = await panel.update(PAGE, page.documentId, { body: "p2 from the panel" });
    expect(saved.status, saved.text).toBe(200);
    const published = await panel.publish(PAGE, page.documentId);
    expect(published.status, published.text).toBe(200);
    const rows = await revisionsOf(page.documentId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ body: "p2 from the panel", editor: null, kind: "after" });
    expect(rows[1].adminEditorId).toEqual(expect.any(Number));
    const [entry] = (await history().listRevisions(t.strapi, page.documentId)).results;
    expect(entry.editor).toEqual({ admin: true });
  });

  it("a discard back to the published content records it; a panel clone records the new page's first", async () => {
    const page = await newPage({ title: "Discarded", body: "live" });
    await docs(PAGE).update({ documentId: page.documentId, data: { body: "draft only" } });
    await docs(PAGE).discardDraft({ documentId: page.documentId });
    expect((await revisionsOf(page.documentId)).map((row) => row.body)).toEqual([
      "live",
      "draft only",
      "live",
    ]);
    // A second discard rebuilds the latest snapshot: nothing new.
    await docs(PAGE).discardDraft({ documentId: page.documentId });
    expect(await revisionsOf(page.documentId)).toHaveLength(3);

    const clone = await panel.clone(PAGE, page.documentId, {
      title: "Discarded (copy)",
      slug: "it-history-clone",
    });
    expect(clone.status, clone.text).toBe(200);
    const copy = await revisionsOf(clone.body.data.documentId as string);
    expect(copy.map((row) => [row.kind, row.title, row.body])).toEqual([
      ["after", "Discarded (copy)", "live"],
    ]);
  });

  it("S5.6 a failing revision insert fails the save; both page rows keep their content", async () => {
    const page = await newPage({ title: "Atomic", body: "kept" });
    const before = await revisionsOf(page.documentId);
    const db = t.strapi.db as unknown as { query(uid: string): Record<string, unknown> };
    const query = db.query.bind(db);
    db.query = (uid: string) => {
      const repository = query(uid);
      if (uid !== REVISION) return repository;
      return {
        ...repository,
        create: async () => {
          throw new Error("revision insert failed");
        },
      };
    };
    try {
      await expect(
        docs(PAGE).update({ documentId: page.documentId, data: { body: "lost" } }),
      ).rejects.toThrow();
    } finally {
      db.query = query;
    }
    expect((await pageRows(page.documentId)).map((row) => row.body)).toEqual(["kept", "kept"]);
    expect(await revisionsOf(page.documentId)).toEqual(before);
  });

  it("the history module: one revision, a restore recorded with restoredFrom although unchanged, another page's revision is null", async () => {
    const page = await newPage({ title: "Restorable", body: "r1", summary: "s1" });
    await docs(PAGE).update({
      documentId: page.documentId,
      data: { title: "Restorable v2", body: "r2", summary: "s2" },
    });
    const [first] = await revisionsOf(page.documentId);
    const other = await newPage({ title: "Other", body: "x" });
    expect(await history().getRevision(t.strapi, other.documentId, first.id)).toBeNull();

    const revision = (await history().getRevision(
      t.strapi,
      page.documentId,
      first.id,
    )) as RevisionDetail;
    expect(revision).toMatchObject({ kind: "after", title: "Restorable", body: "r1" });
    const data = history().restoreData(revision);
    expect(data).toEqual({ title: "Restorable", body: "r1", summary: "s1" });
    await inContext({ editorId: memberId, restoredFrom: first.id }, async () => {
      await docs(PAGE).update({ documentId: page.documentId, data });
      await docs(PAGE).publish({ documentId: page.documentId });
    });
    // Restoring the state the draft already has is recorded too.
    await inContext({ editorId: memberId, restoredFrom: first.id }, () =>
      docs(PAGE).update({ documentId: page.documentId, data }),
    );
    const rows = await revisionsOf(page.documentId);
    expect(rows.map((row) => [row.body, row.restoredFrom])).toEqual([
      ["r1", null],
      ["r2", null],
      ["r1", first.id],
      ["r1", first.id],
    ]);
    const published = (await pageRows(page.documentId)).find((row) => row.publishedAt !== null);
    expect(published).toMatchObject({ title: "Restorable", body: "r1", summary: "s1" });
  });

  it("no read path hands out revision content, to any role (admin_role and editor included)", async () => {
    // The middle draft lives on in its after-image only: no page row holds it.
    const page = await newPage({ title: "Secret history", body: "published" });
    await docs(PAGE).update({ documentId: page.documentId, data: { body: `${SECRET} draft` } });
    await docs(PAGE).update({ documentId: page.documentId, data: { body: "current draft" } });
    expect((await revisionsOf(page.documentId)).map((row) => row.body)).toContain(
      `${SECRET} draft`,
    );
    for (const role of TEST_ROLES) {
      const list = await t.api(role, "/api/wiki-revisions");
      expect({ role, status: list.status }).toEqual({ role, status: 404 });
      for (const path of [
        "/api/wiki-pages?populate=revisions",
        "/api/wiki-pages?populate[revisions][populate]=*",
        `/api/wiki-pages/${page.documentId}?populate=revisions&status=draft`,
      ]) {
        const res = await t.api(role, path);
        expect({ role, path, leaks: res.text.includes(`${SECRET} draft`) }).toEqual({
          role,
          path,
          leaks: false,
        });
        expect({ role, path, revisions: /"revisions"\s*:/.test(res.text) }).toEqual({
          role,
          path,
          revisions: false,
        });
      }
    }
  });

  it(
    "a restart after writes: the guard passes, and no revision lacks published_at",
    async () => {
      await t.stop();
      await boot(false);
      const [row] = await database.sql<{ n: number | string }>(
        "SELECT count(*) AS n FROM wiki_revisions WHERE published_at IS NULL",
      );
      expect(Number(row.n)).toBe(0);
      const [kinds] = await database.sql<{ n: number | string }>(
        "SELECT count(*) AS n FROM wiki_revisions WHERE kind IS NULL OR page_document_id IS NULL",
      );
      expect(Number(kinds.n)).toBe(0);
    },
    BOOT_BUDGET,
  );

  it(
    "the cutover: the state at each upgrade and after a rollback window is recorded as a baseline",
    async () => {
      // A page as batch 15 left it: published "A", then edited to "B" with
      // the batch-15 lifecycle, which recorded the body BEFORE the edit.
      const page = await newPage({ title: "Cutover", body: "A" });
      const documentId = page.documentId;
      const [draft] = (await pageRows(documentId)).filter((row) => row.publishedAt === null);
      await database.sql("DELETE FROM wiki_revisions WHERE page_document_id = ?", [documentId]);
      const legacyBeforeImage = async (body: string) => {
        const [row] = await database.sql<{ id: number }>(
          `INSERT INTO wiki_revisions (document_id, body, created_at, updated_at, published_at)
           VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
          [`legacy${Math.random().toString(36).slice(2, 20).padEnd(18, "0")}`, body],
        );
        await database.sql(
          "INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord) VALUES (?, ?, 1)",
          [row.id, draft.id],
        );
        return row.id;
      };
      await legacyBeforeImage("A");
      await database.sql("UPDATE wiki_pages SET body = 'B' WHERE id = ?", [draft.id]);

      // The upgrade: the boot records B (the draft) and A (published, in no snapshot).
      await t.stop();
      await boot(false);
      const afterUpgrade = await revisionsOf(documentId);
      expect(afterUpgrade.map((row) => [row.kind, row.body])).toEqual([
        ["before", "A"],
        ["baseline", "A"],
        ["baseline", "B"],
      ]);
      await docs(PAGE).update({ documentId, data: { body: "C" } });
      // B stays restorable.
      const baselineB = afterUpgrade[2];
      const revision = (await history().getRevision(
        t.strapi,
        documentId,
        baselineB.id,
      )) as RevisionDetail;
      expect(history().restoreData(revision)).toEqual({
        title: "Cutover",
        body: "B",
        summary: null,
      });

      // A rollback window on 15.1: C → D, with the before-image of C.
      await legacyBeforeImage("C");
      await database.sql("UPDATE wiki_pages SET body = 'D' WHERE id = ?", [draft.id]);
      await t.stop();
      await boot(false);
      // Back on batch 16: D is recorded, and a save back to C (which an older
      // snapshot holds) is recorded too, because it changes the stored row.
      await docs(PAGE).update({ documentId, data: { body: "C" } });
      const rows = await revisionsOf(documentId);
      expect(rows.map((row) => [row.kind, row.body])).toEqual([
        ["before", "A"],
        ["baseline", "A"],
        ["baseline", "B"],
        ["after", "C"],
        ["before", "C"],
        ["baseline", "D"],
        ["after", "C"],
      ]);
    },
    BOOT_BUDGET,
  );
});
