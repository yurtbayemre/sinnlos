import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { storedRevision } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";
import { WIKI_PAGE, rowsOf, seedPage, seedSpace, wikiApi, type WikiApi } from "./wiki.test.helper";

/**
 * A wiki page's history and restore (deep-dive decision 06 §J2, §J3,
 * question 9; batch 16 lane 16B item 4, on lane 16D's revision module K15)
 * on SQLite and Postgres 16:
 *   - `revisions` and `revision` for the page's row classes and moderators
 *     only; another page's revision answers 404 like a missing one;
 *   - `restore` writes the revision's content to the draft and publishes,
 *     in one transaction under one `If-Match`: `after` and `baseline`
 *     entries restore title, body and summary, a legacy `before` entry the
 *     body only; publish readiness applies.
 * The revisions are seeded as rows (the shape lane 16D's lifecycle and
 * backfill write), so most cases do not depend on the lifecycle. Two run
 * on 16D's after-image lifecycle end to end: a save through the actions
 * writes the history the actions read and restore, and a restore records
 * `restoredFrom` (Codex review of 16B; the lane gated them until the batch
 * integration brought the lifecycle into the tree).
 */

const REVISION = "api::wiki-revision.wiki-revision";

describe.each(testEngines())("authoring wiki history on %s", (engine) => {
  let t: TestStrapi;
  let wiki: WikiApi;
  let space: Row & { documentId: string };
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    wiki = wikiApi(t);
    space = await seedSpace(t, { name: "IT History Space" });
  });
  afterAll(async () => {
    await t?.stop();
  });

  /** A revision row of `pageDocumentId`, written raw. */
  const revision = async (pageDocumentId: string, data: Record<string, unknown>) =>
    (await t.strapi.db.query(REVISION).create({
      data: { pageDocumentId, publishedAt: new Date(), ...data },
    })) as Row;

  /** A page of the member in Engineering, with three history entries. */
  async function pageWithHistory() {
    const page = await seedPage(t, {
      title: "IT Current title",
      body: "current body",
      summary: "current summary",
      space: space.documentId,
      author: t.fixtures.users.member.id,
      department: t.fixtures.departments.engineering.documentId,
    });
    const before = await revision(page.documentId, {
      kind: "before",
      body: "legacy body",
      summary: "an old edit note",
      editor: t.fixtures.users.member.id,
    });
    const baseline = await revision(page.documentId, {
      kind: "baseline",
      title: "IT Baseline title",
      body: "baseline body",
      pageSummary: "baseline summary",
    });
    const after = await revision(page.documentId, {
      kind: "after",
      title: "IT After title",
      body: "after body",
      pageSummary: "after summary",
      summary: "fixed a typo",
      editor: t.fixtures.users.member.id,
    });
    return { page, before, baseline, after };
  }

  it("lists the history newest first for the page's editors and moderators, without bodies", async () => {
    const { page, before, baseline, after } = await pageWithHistory();
    // The seeded entries, newest first; the page's create has recorded one
    // more through 16D's lifecycle (the oldest).
    const seeded = [after.id, baseline.id, before.id];
    for (const role of ["member", "department_head", "editor", "admin_role"] as const) {
      const res = await wiki.revisions<Record<string, unknown>>(role, page.documentId);
      expect(res.status, `${role} ${res.text}`).toBe(200);
      const ids = res.body.data.map((entry) => entry.id as number);
      expect(ids.slice(0, 3), role).toEqual(seeded);
      expect(ids, role).toEqual([...ids].sort((x, y) => y - x));
      expect(res.body.meta.pagination.total).toBe(ids.length);
    }
    const res = await wiki.revisions<Record<string, unknown>>("member", page.documentId);
    expect(res.body.data[0]).toEqual({
      id: after.id,
      createdAt: expect.any(String),
      title: "IT After title",
      changeSummary: "fixed a typo",
      kind: "after",
      editor: { id: t.fixtures.users.member.id, displayName: "Fixture member" },
      restoredFrom: null,
    });
    expect(res.body.data[0]).not.toHaveProperty("body");
    expect(res.body.data[1]).toMatchObject({ kind: "baseline", editor: null });
    expect(res.body.data[2]).toMatchObject({ kind: "before", title: null });
    // Not the page's editor: like a page that does not exist; guests hold no grant.
    expect((await wiki.revisions("team_lead", page.documentId)).status).toBe(404);
    expect((await wiki.revisions("guest", page.documentId)).status).toBe(403);
    expect((await wiki.revisions("member", page.documentId, "sort=id")).status).toBe(400);
  });

  it("shows one revision with its content; another page's revision answers 404", async () => {
    const { page, after } = await pageWithHistory();
    const other = await pageWithHistory();
    const res = await wiki.revision<Record<string, unknown>>("member", page.documentId, after.id);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data).toMatchObject({
      id: after.id,
      body: "after body",
      pageSummary: "after summary",
      kind: "after",
    });
    for (const id of [other.after.id, 999_999, "abc"]) {
      expect((await wiki.revision("member", page.documentId, id)).status, String(id)).toBe(404);
    }
    expect((await wiki.revision("team_lead", page.documentId, after.id)).status).toBe(404);
  });

  it("restores an after-image: title, body and summary, published, under If-Match", async () => {
    const { page, after } = await pageWithHistory();
    const version = await storedRevision(t, WIKI_PAGE, page.documentId);
    expect((await wiki.restore("member", page.documentId, after.id)).status).toBe(428);
    expect((await wiki.restore("member", page.documentId, after.id, version + 7)).status).toBe(412);
    const res = await wiki.restore("member", page.documentId, after.id, version);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data).toMatchObject({ status: "published" });
    // One request, two mutations, one transaction: the revision moved by two.
    expect(Number(res.body.data.version)).toBe(version + 2);
    for (const row of await rowsOf(t, WIKI_PAGE, page.documentId)) {
      expect(row).toMatchObject({
        title: "IT After title",
        body: "after body",
        summary: "after summary",
      });
    }
  });

  it("restores a legacy before-image: the body only", async () => {
    const { page, before } = await pageWithHistory();
    const res = await wiki.restore(
      "editor",
      page.documentId,
      before.id,
      await storedRevision(t, WIKI_PAGE, page.documentId),
    );
    expect(res.status, res.text).toBe(200);
    for (const row of await rowsOf(t, WIKI_PAGE, page.documentId)) {
      expect(row).toMatchObject({
        title: "IT Current title",
        body: "legacy body",
        summary: "current summary",
      });
    }
  });

  it("answers 404 for another page's revision and 400 for a malformed body; writes nothing", async () => {
    const { page } = await pageWithHistory();
    const other = await pageWithHistory();
    const version = await storedRevision(t, WIKI_PAGE, page.documentId);
    expect((await wiki.restore("member", page.documentId, other.after.id, version)).status).toBe(
      404,
    );
    expect((await wiki.restore("member", page.documentId, "x", version)).status).toBe(400);
    expect(await storedRevision(t, WIKI_PAGE, page.documentId)).toBe(version);
    expect((await rowsOf(t, WIKI_PAGE, page.documentId))[0].title).toBe("IT Current title");
  });

  it("applies publish readiness: a parent that is no longer published refuses the restore", async () => {
    const parent = await seedPage(t, { space: space.documentId });
    const page = await seedPage(t, {
      title: "IT Child title",
      space: space.documentId,
      parent: parent.documentId,
      author: t.fixtures.users.member.id,
    });
    const after = await revision(page.documentId, { kind: "after", title: "IT T", body: "B" });
    await t.strapi.documents(WIKI_PAGE).unpublish({ documentId: parent.documentId });
    const version = await storedRevision(t, WIKI_PAGE, page.documentId);
    const res = await wiki.restore("member", page.documentId, after.id, version);
    expect(res.status).toBe(400);
    expect(res.body.error?.details).toEqual({
      keys: ["parent"],
      codes: { parent: "notPublishable" },
    });
    // The draft update rolled back with the refused publish.
    expect(await storedRevision(t, WIKI_PAGE, page.documentId)).toBe(version);
    for (const row of await rowsOf(t, WIKI_PAGE, page.documentId)) {
      expect(row.title).toBe("IT Child title");
    }
  });

  it("records the restore as a new revision naming the restored one", async () => {
    const { page, baseline } = await pageWithHistory();
    const res = await wiki.restore(
      "member",
      page.documentId,
      baseline.id,
      await storedRevision(t, WIKI_PAGE, page.documentId),
    );
    expect(res.status, res.text).toBe(200);
    const list = await wiki.revisions<Record<string, unknown>>("member", page.documentId);
    expect(list.body.data[0]).toMatchObject({
      kind: "after",
      restoredFrom: baseline.id,
      editor: { id: t.fixtures.users.member.id },
    });
  });
  it("saves through the actions write the history the actions read: save, list, restore (16D's lifecycle)", async () => {
    const created = await wiki.createDraft("department_head", {
      title: "IT Lifecycle v1",
      body: "one",
      space: space.documentId,
    });
    expect(created.status, created.text).toBe(201);
    const { documentId } = created.body.data;
    const saved = await wiki.saveDraft(
      "department_head",
      documentId,
      { body: "two", revisionSummary: "second" },
      created.body.data.version,
    );
    expect(saved.status, saved.text).toBe(200);
    const list = await wiki.revisions<Record<string, unknown>>("department_head", documentId);
    expect(list.status, list.text).toBe(200);
    expect(list.body.data.map((entry) => [entry.kind, entry.changeSummary])).toEqual([
      ["after", "second"],
      ["after", null],
    ]);
    const first = list.body.data[1].id as number;
    const restored = await wiki.restore(
      "department_head",
      documentId,
      first,
      saved.body.data.version,
    );
    expect(restored.status, restored.text).toBe(200);
    for (const row of await rowsOf(t, WIKI_PAGE, documentId)) expect(row.body).toBe("one");
    const after = await wiki.revisions<Record<string, unknown>>("department_head", documentId);
    expect(after.body.data[0]).toMatchObject({ kind: "after", restoredFrom: first });
  });
});
