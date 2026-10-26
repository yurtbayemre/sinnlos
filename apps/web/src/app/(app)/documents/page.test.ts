import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The document library links files through mediaUrl() (batch 16 plan S21,
 * WD10): a local upload stays a relative /uploads/… path, so the browser
 * loads it from the web origin through the session-gated proxy, never from
 * the cms host; an external provider's absolute URL stays as it is. The
 * size is Strapi's kilobytes, written for people. The library pages on the
 * server with prev/next (v0.30); a page past the end starts over.
 */
vi.stubEnv("STRAPI_PUBLIC_URL", "https://cms.example");
const viewer = { role: "member" as string | null };
const acksMock = vi.fn();
const listMock = vi.fn();
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewer }));
vi.mock("@/lib/acknowledgements", () => ({ fetchMyDocumentAcks: () => acksMock() }));
vi.mock("@/components/announcements/ack-button", () => ({
  AckButton: (props: {
    targetType: string;
    targetDocumentId: string;
    acknowledgedAtLabel: string | null;
  }) =>
    `[ack ${props.targetType} ${props.targetDocumentId} ${props.acknowledgedAtLabel ?? "open"}]`,
}));
vi.mock("@/lib/strapi", () => ({
  api: { documents: { list: (page: number) => listMock(page) } },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
const onePage = (data: unknown[]) => ({
  data,
  meta: { pagination: { page: 1, pageSize: 100, pageCount: 1, total: data.length } },
});
const fiveDocuments = () =>
  onePage([
    {
      id: 1,
      title: "Travel policy",
      category: "policy",
      file: { url: "/uploads/travel_ab12.pdf", name: "travel.pdf", size: 2048 },
    },
    {
      id: 2,
      title: "Form",
      category: "form",
      file: { url: "https://bucket.example/form.pdf", name: "form.pdf", size: 1 },
    },
    { id: 3, title: "Nothing", category: "other", file: null },
    { id: 4, documentId: "docmust", title: "Must read", requiresAck: true, file: null },
    { id: 5, documentId: "docdone", title: "Read", requiresAck: true, file: null },
  ]);
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "1. Oktober 2026" }),
}));

beforeEach(() => {
  viewer.role = "member";
  listMock.mockReset().mockImplementation(async () => fiveDocuments());
  acksMock.mockReset().mockResolvedValue({
    acks: [
      {
        id: 1,
        targetType: "document",
        targetDocumentId: "docdone",
        acknowledgedAt: "2026-10-01T08:00:00.000Z",
      },
    ],
    truncated: false,
  });
});

const { default: DocumentsPage } = await import("./page");

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await DocumentsPage({ searchParams: Promise.resolve(params) }));

describe("/documents", () => {
  it("links a local file relative (the /uploads proxy) and an external one as it is", async () => {
    const html = await render();
    expect(html).toContain('href="/uploads/travel_ab12.pdf"');
    expect(html).not.toContain("https://cms.example/uploads");
    expect(html).toContain('href="https://bucket.example/form.pdf"');
    expect(html).toContain("2.0 MB");
    expect(html).toContain("documents.noFile");
  });

  it("offers the read confirmation of a mandatory document, with the caller's own receipt (v0.20)", async () => {
    const html = await render();
    expect(html).toContain("documents.ackRequired");
    expect(html).toContain("[ack document docmust open]");
    expect(html).toContain("[ack document docdone 1. Oktober 2026]");
  });

  it("shows no confirmation to a guest and does not read receipts", async () => {
    viewer.role = "guest";
    const html = await render();
    expect(html).not.toContain("documents.ackRequired");
    expect(html).not.toContain("[ack");
    expect(acksMock).not.toHaveBeenCalled();
  });

  it("reaches document 1,001 through the pages, with its download and confirmation", async () => {
    const library = Array.from({ length: 1001 }, (_, i) => ({
      id: i + 1,
      documentId: `doc${i + 1}`,
      title: `Document ${i + 1}`,
      category: "policy",
      requiresAck: i === 1000,
      file: { url: `/uploads/doc_${i + 1}.pdf`, name: `doc${i + 1}.pdf`, size: 1 },
    }));
    listMock.mockImplementation(async (page: number) => ({
      data: library.slice((page - 1) * 100, page * 100),
      meta: { pagination: { page, pageSize: 100, pageCount: 11, total: 1001 } },
    }));
    let html = await render();
    expect(html).not.toContain("Document 1001");
    expect(html).not.toContain('rel="prev"');
    const visited = [1];
    for (;;) {
      const next = /<a[^>]*rel="next"[^>]*>/.exec(html)?.[0];
      if (!next) break;
      const page = /href="\/documents\?page=(\d+)"/.exec(next)?.[1];
      expect(page).toBeDefined();
      visited.push(Number(page));
      html = await render({ page: page! });
    }
    expect(visited).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(listMock.mock.calls.map(([page]) => page)).toEqual(visited);
    expect(html).toContain("Document 1001");
    expect(html).toContain('href="/uploads/doc_1001.pdf"');
    expect(html).toContain("[ack document doc1001 open]");
    expect(html).toContain('href="/documents?page=10"');
    expect(html).toContain('rel="prev"');
  });

  it("shows no pager for a single page and starts over past the end", async () => {
    expect(await render()).not.toContain("manage.common.list.pagination");
    listMock.mockImplementation(async () => ({
      data: [],
      meta: { pagination: { page: 12, pageSize: 100, pageCount: 11, total: 1001 } },
    }));
    await expect(render({ page: "12" })).rejects.toThrow("NEXT_REDIRECT /documents");
  });

  it("asks for page 1 when the page parameter is not a valid page", async () => {
    for (const page of ["0", "-1", "1.5", "abc", "10001"]) await render({ page });
    expect(listMock.mock.calls.map(([page]) => page)).toEqual([1, 1, 1, 1, 1]);
  });
});
