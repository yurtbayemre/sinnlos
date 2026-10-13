import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WikiPageListRow } from "@sinnlos/domain";
import { StrapiError } from "@/lib/strapi-error";

/**
 * The wiki's view models (batch 16 plan 16C items 4-7): the page tree of a
 * space (nesting, order, and nothing lost to a legacy parent loop), the
 * parent picker (the space's published pages by path, never the page
 * itself or its subpages), how an editor URL names its page (`?doc=`, else
 * the published page), the history (a hidden page or another page's
 * revision is not found, an outage the banner) and the space list's
 * untrusted filters. strapi() is mocked.
 */
const strapiMock = vi.fn();
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));

const wiki = await import("./wiki");

const doc = (n: number) => `page${String(n).padStart(20, "0")}`;

function row(n: number, patch: Partial<WikiPageListRow> = {}): WikiPageListRow {
  return {
    documentId: doc(n),
    label: `Page ${n}`,
    status: "published",
    publishedAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    version: "1",
    authorName: null,
    needsRetarget: false,
    slug: `page-${n}`,
    space: "spce00000000000000000001",
    parent: null,
    order: 0,
    ...patch,
  };
}

/** The tree as "label(children)" text. */
const shape = (nodes: ReturnType<typeof wiki.buildWikiTree>): string =>
  nodes
    .map((node) =>
      node.children.length ? `${node.row.label}(${shape(node.children)})` : node.row.label,
    )
    .join(" ");

beforeEach(() => {
  strapiMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("buildWikiTree", () => {
  it("nests each page under its parent, by order, then title", () => {
    const rows = [
      row(1, { label: "Setup", order: 2 }),
      row(2, { label: "Laptop", parent: doc(1), order: 1 }),
      row(3, { label: "Accounts", parent: doc(1), order: 1 }),
      row(4, { label: "About", order: 1 }),
      row(5, { label: "VPN", parent: doc(3) }),
    ];
    expect(shape(wiki.buildWikiTree(rows))).toBe("About Setup(Accounts(VPN) Laptop)");
  });

  it("a parent outside the list (or the page itself) makes a root", () => {
    const rows = [row(1, { parent: doc(99) }), row(2, { parent: doc(2) })];
    expect(shape(wiki.buildWikiTree(rows))).toBe("Page 1 Page 2");
  });

  it("keeps every page of a legacy loop, once, cut at one of them", () => {
    const rows = [
      row(1, { label: "A", parent: doc(2) }),
      row(2, { label: "B", parent: doc(1) }),
      row(3, { label: "C" }),
    ];
    const tree = wiki.buildWikiTree(rows);
    const labels: string[] = [];
    const walk = (nodes: typeof tree) =>
      nodes.forEach((node) => {
        labels.push(node.row.label);
        walk(node.children);
      });
    walk(tree);
    expect(labels.sort()).toEqual(["A", "B", "C"]);
  });

  it("loadWikiPageTree walks every page of the space's authoring list", async () => {
    strapiMock
      .mockResolvedValueOnce({
        data: [row(1)],
        meta: { pagination: { page: 1, pageSize: 25, pageCount: 2, total: 2 } },
      })
      .mockResolvedValueOnce({
        data: [row(2, { parent: doc(1) })],
        meta: { pagination: { page: 2, pageSize: 25, pageCount: 2, total: 2 } },
      });
    const view = await wiki.loadWikiPageTree("spce00000000000000000001");
    expect(strapiMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/wiki-pages/authoring?space=spce00000000000000000001",
      "/api/wiki-pages/authoring?space=spce00000000000000000001&page=2",
    ]);
    expect(shape(view.nodes)).toBe("Page 1(Page 2)");
    expect(view).toMatchObject({ total: 2, failed: false, truncated: false });
  });

  it("an outage is failed, never an empty tree; a malformed space id sends nothing", async () => {
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    expect(await wiki.loadWikiPageTree("spce00000000000000000001")).toMatchObject({
      failed: true,
      nodes: [],
    });
    strapiMock.mockClear();
    expect(await wiki.loadWikiPageTree("../x")).toMatchObject({ failed: false, nodes: [] });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("loadWikiParentOptions", () => {
  const parentRow = (n: number, parent: number | null, title = `P${n}`) => ({
    id: n,
    documentId: doc(n),
    title,
    slug: `p${n}`,
    order: 0,
    parent: parent === null ? null : { documentId: doc(parent) },
  });

  it("lists the space's published pages by path, without the page and its subpages", async () => {
    strapiMock.mockResolvedValue({
      data: [
        parentRow(1, null, "Handbook"),
        parentRow(2, 1, "Setup"),
        parentRow(3, 2, "Linux"),
        parentRow(4, null, "About"),
      ],
      meta: { pagination: { page: 1, pageSize: 100, pageCount: 1, total: 4 } },
    });
    const all = await wiki.loadWikiParentOptions("handbook");
    expect(all.options.map((option) => option.label)).toEqual([
      "About",
      "Handbook",
      "Handbook / Setup",
      "Handbook / Setup / Linux",
    ]);
    expect(String(strapiMock.mock.calls[0]![0])).toContain(
      "filters[space][slug][$eq]=handbook&fields[0]=title&fields[1]=slug&fields[2]=order&populate[parent][fields][0]=slug",
    );
    const withoutSetup = await wiki.loadWikiParentOptions("handbook", doc(2));
    expect(withoutSetup.options.map((option) => option.label)).toEqual(["About", "Handbook"]);
  });

  it("a loop in the data ends the path; a failed read is failed", async () => {
    strapiMock.mockResolvedValueOnce({ data: [parentRow(1, 2, "A"), parentRow(2, 1, "B")] });
    const looped = await wiki.loadWikiParentOptions("x");
    expect(looped.options.map((option) => option.label)).toEqual(["A / B", "B / A"]);
    strapiMock.mockRejectedValueOnce(new StrapiError(500, "Error", ""));
    expect(await wiki.loadWikiParentOptions("x")).toMatchObject({ failed: true, options: [] });
  });
});

describe("resolveWikiPageId", () => {
  it("takes a well-formed ?doc= without a request", async () => {
    expect(await wiki.resolveWikiPageId("handbook", "setup", doc(5))).toEqual({
      documentId: doc(5),
      failed: false,
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("else reads the published page of the slugs (a malformed ?doc= is ignored)", async () => {
    strapiMock.mockResolvedValue({
      data: [{ id: 1, documentId: doc(7), title: "S", slug: "setup" }],
    });
    expect(await wiki.resolveWikiPageId("handbook", "setup", "../../users")).toEqual({
      documentId: doc(7),
      failed: false,
    });
    expect(strapiMock).toHaveBeenCalledWith(
      "/api/wiki-pages?filters[space][slug][$eq]=handbook&filters[slug][$eq]=setup&fields[0]=title&fields[1]=slug",
    );
    strapiMock.mockResolvedValue({ data: [] });
    expect(await wiki.resolveWikiPageId("handbook", "nope", undefined)).toEqual({
      documentId: null,
      failed: false,
    });
  });
});

describe("the editor and the history", () => {
  it("editable: 404 and 403 are notFound, an outage failed, a foreign answer failed", async () => {
    strapiMock.mockRejectedValueOnce(new StrapiError(404, "Not Found", ""));
    expect(await wiki.loadWikiPageEditable(doc(1))).toEqual({ state: "notFound" });
    strapiMock.mockRejectedValueOnce(new StrapiError(403, "Forbidden", ""));
    expect(await wiki.loadWikiSpaceEditable(doc(1))).toEqual({ state: "notFound" });
    strapiMock.mockRejectedValueOnce(new StrapiError(502, "Bad Gateway", ""));
    expect(await wiki.loadWikiPageEditable(doc(1))).toEqual({ state: "failed" });
    strapiMock.mockResolvedValueOnce({ data: { documentId: doc(2), version: "1" } });
    expect(await wiki.loadWikiPageEditable(doc(1))).toEqual({ state: "failed" });
    expect(await wiki.loadWikiPageEditable("nope")).toEqual({ state: "notFound" });
  });

  it("the history: one page of entries; a hidden page is notFound", async () => {
    strapiMock.mockResolvedValueOnce({
      data: [
        {
          id: 3,
          createdAt: "2026-10-01T08:00:00.000Z",
          title: "T",
          changeSummary: null,
          kind: "after",
          editor: null,
          restoredFrom: null,
        },
      ],
      meta: { pagination: { page: 2, pageSize: 25, pageCount: 2, total: 26 } },
    });
    const view = await wiki.loadWikiHistory(doc(1), 2);
    expect(strapiMock).toHaveBeenCalledWith(`/api/wiki-pages/${doc(1)}/revisions?page=2`);
    expect(view.state).toBe("ok");
    expect(view.entries).toHaveLength(1);
    strapiMock.mockRejectedValueOnce(new StrapiError(404, "Not Found", ""));
    expect((await wiki.loadWikiHistory(doc(1), 1)).state).toBe("notFound");
  });

  it("one revision: another page's (404) or a mismatched id is notFound", async () => {
    strapiMock.mockRejectedValueOnce(new StrapiError(404, "Not Found", ""));
    expect(await wiki.loadWikiRevision(doc(1), 9)).toEqual({ state: "notFound" });
    strapiMock.mockResolvedValueOnce({ data: { id: 8 } });
    expect(await wiki.loadWikiRevision(doc(1), 9)).toEqual({ state: "notFound" });
    expect(strapiMock).toHaveBeenLastCalledWith(`/api/wiki-pages/${doc(1)}/revisions/9`);
  });

  it("reads the URL's page and rev as bounded integers", () => {
    expect(wiki.historyPage({ page: "3" })).toBe(3);
    expect(wiki.historyPage({ page: "-1" })).toBe(1);
    expect(wiki.historyPage({ page: "x" })).toBe(1);
    expect(wiki.revisionParam({ rev: "41" })).toBe(41);
    expect(wiki.revisionParam({ rev: "0" })).toBeNull();
    expect(wiki.revisionParam({ rev: "4e1" })).toBeNull();
    expect(wiki.revisionParam({ rev: ["7", "8"] })).toBe(7);
  });
});

describe("the space list", () => {
  it("drops what the URL should not carry: q capped and trimmed, page bounded", () => {
    expect(wiki.parseWikiSpaceFilters({ q: `  ${"x".repeat(150)} `, page: "0" })).toEqual({
      q: "x".repeat(100),
      page: 1,
    });
  });

  it("asks the cms with q and page; an outage is the banner", async () => {
    strapiMock.mockResolvedValueOnce({
      data: [],
      meta: { pagination: { page: 2, pageSize: 25, pageCount: 2, total: 26 } },
    });
    const view = await wiki.loadWikiSpaceList({ q: "hand book", page: 2 });
    expect(strapiMock).toHaveBeenCalledWith("/api/wiki-spaces/authoring?q=hand%20book&page=2");
    expect(view).toMatchObject({ empty: true, failed: false });
    strapiMock.mockRejectedValueOnce(new StrapiError(502, "Bad Gateway", ""));
    expect(await wiki.loadWikiSpaceList({ q: "", page: 1 })).toMatchObject({
      failed: true,
      empty: false,
    });
  });
});
