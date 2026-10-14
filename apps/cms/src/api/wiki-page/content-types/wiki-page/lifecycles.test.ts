/**
 * Wiki page history as after-images (decision 06 §J3, DA03; batch 16 lane
 * 16D, contract K16): afterCreate/afterUpdate of a draft row record the
 * state the save leads to; beforeUpdate keeps the stored content to compare
 * with. The real Strapi runs beforeUpdate and afterUpdate with one shared
 * event state (@strapi/database 5.57 lifecycles/index.js, pinned in
 * framework-contract.test.ts); `save` below does the same around a write to
 * the stub row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { USER, createOrgStub } from "../../../../test/org-fixtures.test.helper";
import type { Row, StrapiStub } from "../../../../test/strapi-stub.test.helper";
import { wikiEditContext, type WikiEditContext } from "../../../../utils/wiki-edit-context";
import lifecycles from "./lifecycles";

const PAGE_UID = "api::wiki-page.wiki-page";
const REVISION_UID = "api::wiki-revision.wiki-revision";
const DOC = "w0000000000000000000000a";
const DRAFT_ID = 40;
const PUBLISHED_ID = 41;

afterEach(() => {
  vi.unstubAllGlobals();
});

const page = (id: number, data: Partial<Row> = {}): Row => ({
  id,
  documentId: DOC,
  title: "Onboarding",
  body: "Old body",
  summary: "Old summary",
  order: 0,
  publishedAt: null,
  ...data,
});

function setup(
  options: { revisions?: Row[]; pages?: Row[]; requestContext?: unknown } = {},
): StrapiStub {
  const strapi = createOrgStub({
    requestContext: options.requestContext,
    extraTables: {
      [PAGE_UID]: options.pages ?? [page(DRAFT_ID)],
      [REVISION_UID]: options.revisions ?? [],
    },
  });
  vi.stubGlobal("strapi", strapi);
  return strapi;
}

const revisions = (strapi: StrapiStub) => strapi.tables[REVISION_UID] ?? [];

/** beforeUpdate, the write, afterUpdate: as the entity manager runs an update. */
async function save(
  strapi: StrapiStub,
  data: Record<string, unknown>,
  { id = DRAFT_ID, context }: { id?: number; context?: WikiEditContext } = {},
) {
  const run = async () => {
    const state: Record<string, unknown> = {};
    const params = { where: { id }, data };
    await lifecycles.beforeUpdate({ params, state });
    const row = strapi.tables[PAGE_UID].find((entry) => entry.id === id);
    if (row) Object.assign(row, data);
    await lifecycles.afterUpdate({ params, state, result: row ? { id } : null });
  };
  return context ? wikiEditContext.run(context, run) : run();
}

/** The insert, then afterCreate: as the entity manager runs a create. */
async function create(strapi: StrapiStub, row: Row, context?: WikiEditContext) {
  const run = async () => {
    strapi.tables[PAGE_UID].push(row);
    await lifecycles.afterCreate({ params: { data: { ...row } }, result: { id: row.id } });
  };
  return context ? wikiEditContext.run(context, run) : run();
}

const snapshot = (id: number, data: Partial<Row> = {}): Row => ({
  id,
  documentId: `r${String(id).padStart(23, "0")}`,
  pageDocumentId: DOC,
  title: "Onboarding",
  body: "Old body",
  pageSummary: "Old summary",
  kind: "after",
  publishedAt: "2026-10-13T09:00:00.000Z",
  ...data,
});

describe("wiki-page after-images: what is recorded", () => {
  it("records title, body and page summary of the draft after the save, with the context's editor and note", async () => {
    const strapi = setup();
    await save(
      strapi,
      { title: "Onboarding v2", body: "New body", summary: "New summary" },
      { context: { editorId: USER.alice, revisionSummary: "typo" } },
    );
    expect(revisions(strapi)).toEqual([
      expect.objectContaining({
        page: { id: DRAFT_ID },
        pageDocumentId: DOC,
        title: "Onboarding v2",
        body: "New body",
        pageSummary: "New summary",
        summary: "typo",
        kind: "after",
        editor: { id: USER.alice },
        adminEditorId: null,
        restoredFrom: null,
      }),
    ]);
    expect(revisions(strapi)[0].publishedAt).toEqual(expect.any(Date));
  });

  it("records a summary-only change and a title-only change", async () => {
    const strapi = setup();
    await save(strapi, { summary: "Only the summary" });
    await save(strapi, { title: "Only the title" });
    expect(
      revisions(strapi).map((row) => [row.title, row.body, row.pageSummary, row.kind]),
    ).toEqual([
      ["Onboarding", "Old body", "Only the summary", "after"],
      ["Only the title", "Old body", "Only the summary", "after"],
    ]);
  });

  it("compares with the stored row, not the latest snapshot: a return to an earlier state is recorded", async () => {
    // The latest snapshot holds "C"; the stored row was changed to "D" by a
    // writer without this lifecycle (a rollback window): saving C again is a change.
    const strapi = setup({
      pages: [page(DRAFT_ID, { body: "D" })],
      revisions: [snapshot(1, { body: "C" })],
    });
    await save(strapi, { body: "C" });
    expect(revisions(strapi).map((row) => row.body)).toEqual(["C", "C"]);
  });

  it("skips an order-only or relation-only save, and a save that writes the stored content again", async () => {
    const strapi = setup();
    await save(strapi, { order: 3 });
    await save(strapi, { tags: ["x"], body: "Old body" });
    await save(strapi, { summary: null });
    expect(revisions(strapi)).toHaveLength(1);
    // Empty and missing values compare equal.
    await save(strapi, { summary: "" });
    expect(revisions(strapi)).toHaveLength(1);
  });

  it("records nothing for the published row (a publish copies the draft; a raw write to it)", async () => {
    const strapi = setup({
      pages: [page(DRAFT_ID), page(PUBLISHED_ID, { publishedAt: "2026-10-13T09:00:00.000Z" })],
    });
    await create(strapi, page(42, { body: "Published copy", publishedAt: new Date() }));
    await save(strapi, { body: "Raw edit" }, { id: PUBLISHED_ID });
    expect(revisions(strapi)).toEqual([]);
  });

  it("ignores the payload's revisionSummary (the dead DA03 fallback)", async () => {
    const strapi = setup();
    await save(strapi, { body: "New body", revisionSummary: "from the payload" });
    expect(revisions(strapi)[0]).toMatchObject({ summary: null, editor: null });
  });
});

describe("wiki-page after-images: creates", () => {
  it("a new page records its first after-image", async () => {
    const strapi = setup({ pages: [] });
    await create(strapi, page(50, { documentId: "w0000000000000000000000n", body: "First" }), {
      editorId: USER.dave,
    });
    expect(revisions(strapi)).toEqual([
      expect.objectContaining({
        pageDocumentId: "w0000000000000000000000n",
        body: "First",
        kind: "after",
        editor: { id: USER.dave },
        page: { id: 50 },
      }),
    ]);
  });

  it("a discard or a draft-twin repair that rebuilds the latest snapshot records nothing", async () => {
    const strapi = setup({ pages: [], revisions: [snapshot(1, { kind: "baseline" })] });
    await create(strapi, page(51));
    expect(revisions(strapi)).toHaveLength(1);
  });

  it("a discard back to content the latest snapshot does not hold is recorded", async () => {
    const strapi = setup({
      pages: [],
      revisions: [snapshot(1, { body: "Published body" }), snapshot(2, { body: "Draft body" })],
    });
    await create(strapi, page(51, { body: "Published body" }));
    expect(revisions(strapi).map((row) => row.body)).toEqual([
      "Published body",
      "Draft body",
      "Published body",
    ]);
  });

  it("only after and baseline rows count as snapshots, not a legacy before row", async () => {
    const strapi = setup({ pages: [], revisions: [snapshot(1, { kind: "before", title: null })] });
    await create(strapi, page(51, { title: null, summary: null, body: "Old body" }));
    expect(revisions(strapi)).toHaveLength(2);
  });
});

describe("wiki-page after-images: restores", () => {
  it("a restore always records, with restoredFrom, also when nothing changed", async () => {
    const strapi = setup({ revisions: [snapshot(7)] });
    await save(
      strapi,
      { body: "Old body" },
      { context: { editorId: USER.carol, restoredFrom: 7 } },
    );
    expect(revisions(strapi)[1]).toMatchObject({
      kind: "after",
      restoredFrom: 7,
      editor: { id: USER.carol },
      body: "Old body",
    });
  });

  it("a restore that creates the draft (a published-only page) records too", async () => {
    const strapi = setup({ pages: [], revisions: [snapshot(7)] });
    await create(strapi, page(52), { editorId: USER.carol, restoredFrom: 7 });
    expect(revisions(strapi)).toHaveLength(2);
    expect(revisions(strapi)[1]).toMatchObject({ restoredFrom: 7 });
  });
});

describe("wiki-page after-images: who", () => {
  it("an admin-panel request records the admin user, not data.updatedBy", async () => {
    const strapi = setup({
      requestContext: { state: { auth: { strategy: { name: "admin" } }, user: { id: 9 } } },
    });
    await save(strapi, { body: "Panel edit", updatedBy: 3 });
    expect(revisions(strapi)[0]).toMatchObject({ adminEditorId: 9, editor: null });
  });

  it("a users-permissions request without a context records its caller", async () => {
    const strapi = setup({
      requestContext: {
        state: { auth: { strategy: { name: "users-permissions" } }, user: { id: USER.bob } },
      },
    });
    await save(strapi, { body: "Web edit" });
    expect(revisions(strapi)[0]).toMatchObject({ editor: { id: USER.bob }, adminEditorId: null });
  });

  it("the context's editor wins over the request's caller; a boot write has neither", async () => {
    const strapi = setup({
      requestContext: {
        state: { auth: { strategy: { name: "users-permissions" } }, user: { id: USER.bob } },
      },
    });
    await save(strapi, { body: "Web edit" }, { context: { editorId: USER.alice } });
    expect(revisions(strapi)[0]).toMatchObject({ editor: { id: USER.alice } });

    const boot = setup();
    await save(boot, { body: "Seed edit" });
    expect(revisions(boot)[0]).toMatchObject({ editor: null, adminEditorId: null });
  });
});

describe("wiki-page after-images: transaction", () => {
  it("writes inside the save's transaction, before the commit", async () => {
    const strapi = setup();
    let inside = -1;
    await strapi.db.transaction(async () => {
      await save(strapi, { body: "New body" });
      inside = revisions(strapi).length;
    });
    expect(inside).toBe(1);
  });

  it("a failing insert fails the save (no catch)", async () => {
    const strapi = setup();
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      const q = query(uid);
      if (uid !== REVISION_UID) return q;
      return {
        ...q,
        create: async () => {
          throw new Error("insert failed");
        },
      };
    };
    await expect(save(strapi, { body: "New body" })).rejects.toThrow("insert failed");
    await expect(create(strapi, page(53, { body: "Other" }))).rejects.toThrow("insert failed");
  });

  it("does nothing without a where clause or a result row", async () => {
    const strapi = setup();
    await lifecycles.beforeUpdate({ params: { where: {}, data: { body: "x" } }, state: {} });
    await lifecycles.afterUpdate({ params: {}, state: {}, result: null });
    await lifecycles.afterCreate({ params: {}, result: { id: 999 } });
    expect(revisions(strapi)).toEqual([]);
  });
});
