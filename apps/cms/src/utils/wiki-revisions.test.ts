/**
 * The history reads of DA03 (contract K15): ordering and pagination, the
 * page anchor (another page's revision is null), the editor projection and
 * what a restore writes per kind. Runs against the typed stub over the real
 * wiki-revision schema.json.
 */
import { describe, expect, it } from "vitest";

import { USER, createOrgStub } from "../test/org-fixtures.test.helper";
import type { Row } from "../test/strapi-stub.test.helper";
import {
  REVISION_MAX_PAGE_SIZE,
  WIKI_REVISION_UID,
  getRevision,
  kindOf,
  listRevisions,
  restoreData,
  type RevisionDetail,
} from "./wiki-revisions";

const PAGE = "w0000000000000000000000a";
const OTHER = "w0000000000000000000000b";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 9, minute)).toISOString();

function revision(id: number, data: Partial<Row> = {}): Row {
  return {
    id,
    documentId: `r${String(id).padStart(23, "0")}`,
    pageDocumentId: PAGE,
    title: `Title ${id}`,
    body: `Body ${id}`,
    pageSummary: `Summary ${id}`,
    summary: null,
    kind: "after",
    editor: null,
    adminEditorId: null,
    restoredFrom: null,
    createdAt: at(id),
    publishedAt: at(id),
    ...data,
  };
}

function setup(rows: Row[]) {
  return createOrgStub({ extraTables: { [WIKI_REVISION_UID]: rows } });
}

describe("listRevisions", () => {
  it("lists one page's revisions newest first, without bodies, with the editor projection", async () => {
    const strapi = setup([
      revision(1, { kind: null, title: null, pageSummary: null, summary: "legacy note" }),
      revision(2, { kind: "baseline" }),
      revision(3, { editor: { id: USER.alice }, summary: "typo" }),
      revision(4, { adminEditorId: 9 }),
      revision(5, { pageDocumentId: OTHER }),
      revision(6, { editor: { id: USER.carol }, restoredFrom: 2 }),
    ]);
    const list = await listRevisions(strapi, PAGE);
    expect(list.pagination).toEqual({ page: 1, pageSize: 20, pageCount: 1, total: 5 });
    expect(list.results).toEqual([
      {
        id: 6,
        createdAt: at(6),
        title: "Title 6",
        changeSummary: null,
        kind: "after",
        editor: { id: USER.carol, displayName: "Carol" },
        restoredFrom: 2,
      },
      {
        id: 4,
        createdAt: at(4),
        title: "Title 4",
        changeSummary: null,
        kind: "after",
        editor: { admin: true },
        restoredFrom: null,
      },
      {
        id: 3,
        createdAt: at(3),
        title: "Title 3",
        changeSummary: "typo",
        kind: "after",
        editor: { id: USER.alice, displayName: "Alice" },
        restoredFrom: null,
      },
      {
        id: 2,
        createdAt: at(2),
        title: "Title 2",
        changeSummary: null,
        kind: "baseline",
        editor: null,
        restoredFrom: null,
      },
      {
        id: 1,
        createdAt: at(1),
        title: null,
        changeSummary: "legacy note",
        kind: "before",
        editor: null,
        restoredFrom: null,
      },
    ]);
    for (const entry of list.results) expect(entry).not.toHaveProperty("body");
  });

  it("pages through the history and caps the page size", async () => {
    const strapi = setup(Array.from({ length: 7 }, (_, index) => revision(index + 1)));
    const second = await listRevisions(strapi, PAGE, { page: 2, pageSize: 3 });
    expect(second.results.map((entry) => entry.id)).toEqual([4, 3, 2]);
    expect(second.pagination).toEqual({ page: 2, pageSize: 3, pageCount: 3, total: 7 });
    const beyond = await listRevisions(strapi, PAGE, { page: 4, pageSize: 3 });
    expect(beyond.results).toEqual([]);
    expect(beyond.pagination.total).toBe(7);

    const capped = await listRevisions(strapi, PAGE, { pageSize: 10_000 });
    expect(capped.pagination.pageSize).toBe(REVISION_MAX_PAGE_SIZE);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect((await listRevisions(strapi, PAGE, { page: bad, pageSize: bad })).pagination).toEqual({
        page: 1,
        pageSize: 20,
        pageCount: 1,
        total: 7,
      });
    }
  });

  it("an empty history is one empty page", async () => {
    expect(await listRevisions(setup([]), PAGE)).toEqual({
      results: [],
      pagination: { page: 1, pageSize: 20, pageCount: 1, total: 0 },
    });
  });
});

describe("getRevision", () => {
  const rows = () => [
    revision(1, { editor: { id: USER.bob }, summary: "note" }),
    revision(2, { pageDocumentId: OTHER }),
  ];

  it("returns one revision of the page with its content", async () => {
    expect(await getRevision(setup(rows()), PAGE, 1)).toEqual({
      id: 1,
      createdAt: at(1),
      title: "Title 1",
      changeSummary: "note",
      kind: "after",
      editor: { id: USER.bob, displayName: "Bob" },
      restoredFrom: null,
      body: "Body 1",
      pageSummary: "Summary 1",
    });
    expect(await getRevision(setup(rows()), PAGE, "1")).toMatchObject({ id: 1 });
  });

  it("is null for another page's revision, a missing one and a malformed id", async () => {
    const strapi = setup(rows());
    expect(await getRevision(strapi, PAGE, 2)).toBeNull();
    expect(await getRevision(strapi, OTHER, 1)).toBeNull();
    expect(await getRevision(strapi, PAGE, 99)).toBeNull();
    for (const bad of [0, -1, 1.5, "1; drop", "", null, undefined, { id: 1 }]) {
      expect(await getRevision(strapi, PAGE, bad)).toBeNull();
    }
    expect(await getRevision(strapi, "", 1)).toBeNull();
  });
});

describe("restoreData", () => {
  const detail = (kind: RevisionDetail["kind"], extra: Partial<RevisionDetail> = {}) =>
    ({
      id: 1,
      createdAt: at(1),
      title: "Old title",
      changeSummary: "note",
      kind,
      editor: null,
      restoredFrom: null,
      body: "Old body",
      pageSummary: "Old summary",
      ...extra,
    }) satisfies RevisionDetail;

  it("after and baseline rows restore title, body and page summary", () => {
    for (const kind of ["after", "baseline"] as const) {
      expect(restoreData(detail(kind))).toEqual({
        title: "Old title",
        body: "Old body",
        summary: "Old summary",
      });
    }
    expect(restoreData(detail("after", { pageSummary: null }))).toEqual({
      title: "Old title",
      body: "Old body",
      summary: null,
    });
  });

  it("a legacy before row restores the body only", () => {
    expect(restoreData(detail("before", { title: null, pageSummary: null }))).toEqual({
      body: "Old body",
    });
  });

  it("reads NULL and unknown kinds as legacy before rows", () => {
    expect([kindOf(null), kindOf(undefined), kindOf("other")]).toEqual([
      "before",
      "before",
      "before",
    ]);
    expect([kindOf("after"), kindOf("baseline"), kindOf("before")]).toEqual([
      "after",
      "baseline",
      "before",
    ]);
  });
});
