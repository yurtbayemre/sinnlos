import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { WikiHistoryList } from "@/components/wiki-editor/wiki-history";
import { WikiPageEditor } from "@/components/wiki-editor/wiki-page-editor";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";

/**
 * The wiki's authoring pages and their gates (decision 06 §J2, §L1; batch
 * 16 plan 16C items 5-6), with batch 16's capabilities: /wiki/[space]/new
 * for department heads, team leads and moderators; the editor and the
 * history for every role that edits wiki pages, where `editable` decides
 * (a page the caller has no class on is the not-found page); /wiki/drafts;
 * `?doc=` names a draft without a published route; the URL stays
 * canonical. The page trees are searched, not rendered; strapi() is mocked.
 */
const strapiMock = vi.fn();
const viewerRef: { current: Viewer } = { current: null as unknown as Viewer };

vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewerRef.current }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "" }),
}));

const { default: NewWikiPagePage } = await import("./[space]/new/page");
const { default: EditWikiPagePage } = await import("./[space]/[slug]/edit/page");
const { default: WikiHistoryPage } = await import("./[space]/[slug]/history/page");
const { default: WikiDraftsPage } = await import("./drafts/page");
const { default: WikiReaderPage } = await import("./[space]/[slug]/page");
const { default: WikiSpaceReaderPage } = await import("./[space]/page");

const SPACE = { id: 1, documentId: "spce00000000000000000001", name: "Handbook", slug: "handbook" };
const PAGE = "page00000000000000000001";
const viewer = (role: string | null): Viewer => ({
  id: 7,
  displayName: "Ada",
  role,
  department: null,
});

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

/** The path of Next's redirect error, or null. */
async function redirectOf(render: () => unknown): Promise<string | null> {
  try {
    await render();
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw error;
    return digest.split(";")[2] ?? null;
  }
}

const editableAnswer = (patch: Record<string, unknown> = {}) => ({
  data: {
    documentId: PAGE,
    version: "3",
    status: "published",
    publishedAt: "2026-10-01T08:00:00.000Z",
    updatedAt: null,
    roleClass: "author",
    title: "Setup",
    slug: "setup",
    body: "",
    summary: null,
    tags: [],
    tocEnabled: true,
    order: 0,
    space: { documentId: SPACE.documentId, slug: "handbook", name: "Handbook" },
    parent: null,
    canDiscardUnpublished: true,
    ...patch,
  },
});

const list = (rows: unknown[] = []) => ({
  data: rows,
  meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total: rows.length } },
});

const paths = () => strapiMock.mock.calls.map(([path]) => String(path));

beforeEach(() => {
  strapiMock.mockReset().mockResolvedValue(list());
  viewerRef.current = viewer("member");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const params = (slug = "setup") => Promise.resolve({ space: "handbook", slug });
const search = (query: Record<string, string> = {}) => Promise.resolve(query);

describe("/wiki/[space]/new", () => {
  it.each(["member", "guest", null])("%s goes back to the space", async (role) => {
    viewerRef.current = viewer(role);
    expect(
      await redirectOf(() =>
        NewWikiPagePage({
          params: Promise.resolve({ space: "handbook" }),
          searchParams: search({ create: "1" }),
        }),
      ),
    ).toBe("/wiki/handbook");
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("a team lead gets the editor in the space the address names", async () => {
    viewerRef.current = viewer("team_lead");
    strapiMock.mockImplementation(async (path: string) =>
      path.startsWith("/api/wiki-spaces") ? list([SPACE]) : list(),
    );
    const tree = elements(
      await NewWikiPagePage({
        params: Promise.resolve({ space: "handbook" }),
        searchParams: search({ create: "1" }),
      }),
    );
    const editor = tree.find((el) => el.type === WikiPageEditor);
    expect(editor?.props.space).toEqual({
      documentId: SPACE.documentId,
      name: "Handbook",
      slug: "handbook",
    });
    expect(editor?.props.editable).toBeNull();
    // No department or team list for a team lead.
    expect(paths().some((path) => path.startsWith("/api/departments"))).toBe(false);
  });

  it("a space the caller cannot read is the not-found page", async () => {
    viewerRef.current = viewer("editor");
    await expect(
      NewWikiPagePage({
        params: Promise.resolve({ space: "secret" }),
        searchParams: search({ create: "1" }),
      }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });
});

describe("/wiki/[space]/[slug]/edit", () => {
  it("a guest goes back to the page", async () => {
    viewerRef.current = viewer("guest");
    expect(
      await redirectOf(() => EditWikiPagePage({ params: params(), searchParams: search() })),
    ).toBe("/wiki/handbook/setup");
  });

  it("?doc= names the page without the slug read; the form gets `editable`", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.endsWith("/editable") ? editableAnswer() : list(),
    );
    const tree = elements(
      await EditWikiPagePage({ params: params(), searchParams: search({ doc: PAGE }) }),
    );
    expect(paths()[0]).toBe(`/api/wiki-pages/${PAGE}/editable`);
    expect(tree.find((el) => el.type === WikiPageEditor)?.props.editable).toMatchObject({
      documentId: PAGE,
      roleClass: "author",
    });
  });

  it("without ?doc= the published page of the slugs names it", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.endsWith("/editable")
        ? editableAnswer()
        : path.includes("filters[slug]")
          ? list([{ id: 1, documentId: PAGE, title: "Setup", slug: "setup" }])
          : list(),
    );
    const tree = elements(await EditWikiPagePage({ params: params(), searchParams: search() }));
    expect(tree.some((el) => el.type === WikiPageEditor)).toBe(true);
  });

  it("a page the caller has no class on (the cms's 404) is the not-found page", async () => {
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    await expect(
      EditWikiPagePage({ params: params(), searchParams: search({ doc: PAGE }) }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("keeps the URL canonical: the page's own space and slug", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.endsWith("/editable") ? editableAnswer({ slug: "laptop-setup" }) : list(),
    );
    expect(
      await redirectOf(() =>
        EditWikiPagePage({ params: params(), searchParams: search({ doc: PAGE }) }),
      ),
    ).toBe(`/wiki/handbook/laptop-setup/edit?doc=${PAGE}`);
  });

  it("an outage shows the banner, never the form", async () => {
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const tree = elements(
      await EditWikiPagePage({ params: params(), searchParams: search({ doc: PAGE }) }),
    );
    expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
    expect(tree.some((el) => el.type === WikiPageEditor)).toBe(false);
  });
});

describe("/wiki/[space]/[slug]/history", () => {
  it("a guest goes back to the page", async () => {
    viewerRef.current = viewer("guest");
    expect(
      await redirectOf(() => WikiHistoryPage({ params: params(), searchParams: search() })),
    ).toBe("/wiki/handbook/setup");
  });

  it("a reader without a class on the page (404) is the not-found page", async () => {
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    await expect(
      WikiHistoryPage({ params: params(), searchParams: search({ doc: PAGE }) }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("the page's editors get the versions, newest first as the cms answers", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.endsWith("/editable")
        ? editableAnswer()
        : path.includes("/revisions")
          ? list([
              {
                id: 2,
                createdAt: "2026-10-12T08:00:00.000Z",
                title: "Setup",
                changeSummary: null,
                kind: "after",
                editor: null,
                restoredFrom: null,
              },
            ])
          : list(),
    );
    const tree = elements(
      await WikiHistoryPage({ params: params(), searchParams: search({ doc: PAGE }) }),
    );
    expect(paths()).toContain(`/api/wiki-pages/${PAGE}/revisions`);
    expect(tree.find((el) => el.type === WikiHistoryList)?.props.entries).toHaveLength(1);
  });
});

describe("/wiki/drafts", () => {
  it.each(["guest", null])("%s goes back to the wiki", async (role) => {
    viewerRef.current = viewer(role);
    expect(await redirectOf(() => WikiDraftsPage({ searchParams: search({ mine: "1" }) }))).toBe(
      "/wiki",
    );
  });

  it("lists the caller's drafts (myDrafts); none is the empty state", async () => {
    strapiMock.mockResolvedValue({ data: [] });
    const tree = elements(await WikiDraftsPage({ searchParams: search({ mine: "1" }) }));
    expect(paths()).toEqual(["/api/wiki-pages/drafts/mine"]);
    expect(tree.some((el) => el.type === EmptyState)).toBe(true);
  });

  it("an outage is the banner, not the empty state", async () => {
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const tree = elements(await WikiDraftsPage({ searchParams: search({ mine: "1" }) }));
    expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
    expect(tree.some((el) => el.type === EmptyState)).toBe(false);
  });
});

describe("the two routes inside the readers' slug namespace (Codex review)", () => {
  it("/wiki/[space]/new without ?create=1 shows the space's page `new` when it has one", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.includes("filters[slug][$eq]=new")
        ? list([{ id: 9, documentId: PAGE, title: "New", slug: "new" }])
        : list(),
    );
    viewerRef.current = viewer("guest");
    const tree = elements(
      await NewWikiPagePage({
        params: Promise.resolve({ space: "handbook" }),
        searchParams: search(),
      }),
    );
    expect(tree[0]?.type).toBe(WikiReaderPage);
  });

  it("without such a page it is the form for a creator, and ?create=1 never reads the page", async () => {
    viewerRef.current = viewer("team_lead");
    strapiMock.mockImplementation(async (path: string) =>
      path.startsWith("/api/wiki-spaces") ? list([SPACE]) : list(),
    );
    const tree = elements(
      await NewWikiPagePage({
        params: Promise.resolve({ space: "handbook" }),
        searchParams: search(),
      }),
    );
    expect(tree.some((el) => el.type === WikiPageEditor)).toBe(true);
    strapiMock.mockClear();
    await NewWikiPagePage({
      params: Promise.resolve({ space: "handbook" }),
      searchParams: search({ create: "1" }),
    });
    expect(paths().some((path) => path.includes("filters[slug][$eq]=new"))).toBe(false);
  });

  it("/wiki/drafts without ?mine=1 shows a space whose slug is `drafts`", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.includes("filters[slug][$eq]=drafts") ? list([{ ...SPACE, slug: "drafts" }]) : list(),
    );
    const tree = elements(await WikiDraftsPage({ searchParams: search() }));
    expect(tree[0]?.type).toBe(WikiSpaceReaderPage);
    const mine = elements(await WikiDraftsPage({ searchParams: search({ mine: "1" }) }));
    expect(mine.some((el) => el.type === WikiSpaceReaderPage)).toBe(false);
  });
});
