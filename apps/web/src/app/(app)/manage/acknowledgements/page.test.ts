import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageNav } from "@/components/manage/list";

/**
 * The ack report's pagers (v0.31, #173): each section has its own page in
 * the URL (`page`, `documentsPage`), a section's links keep the other
 * section's page, invalid parameters are page 1, and after a fallback to
 * the last page the links start from the page shown. The loader is mocked;
 * the returned element tree is searched, not rendered.
 */
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/loaders/ack-report", () => ({ loadAckReport: (pages: unknown) => load(pages) }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "Ada", role: "admin_role", department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getLocale: async () => "en",
}));

const { default: AckReportPage } = await import("./page");

type Navs = { hrefOf: (page: number) => string }[];

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

const row = (id: number) => ({
  id,
  title: `Item ${id}`,
  audience: { department: null, team: null, roles: [] },
  ackDeadline: null,
  targetUnknown: false,
  pct: 100,
  ackedCount: 1,
  targetTotal: 1,
  openUsers: [],
});

const view = (announcementsPage: number, documentsPage: number) => ({
  rows: [row(1)],
  documentRows: [row(2)],
  announcementsPage: { page: announcementsPage, pageCount: 4, total: 70 },
  documentsPage: { page: documentsPage, pageCount: 3, total: 50 },
  empty: false,
  failed: false,
  truncated: false,
});

const navsOf = async (searchParams?: Record<string, string | string[]>) => {
  const tree = elements(
    await AckReportPage(searchParams ? { searchParams: Promise.resolve(searchParams) } : undefined),
  );
  return tree.filter((el) => el.type === PageNav).map((el) => el.props) as unknown as Navs;
};

const BASE = "/manage/acknowledgements";

beforeEach(() => {
  load
    .mockReset()
    .mockImplementation(async (pages: { page: number; documentsPage: number }) =>
      view(pages.page, pages.documentsPage),
    );
});

describe("the ack report's pagers", () => {
  it("reads each section's page and keeps the other one in every link", async () => {
    const [announcements, documents] = await navsOf({ page: "3", documentsPage: "2" });
    expect(load).toHaveBeenCalledWith({ page: 3, documentsPage: 2 });
    expect(announcements!.hrefOf(4)).toBe(`${BASE}?page=4&documentsPage=2`);
    expect(announcements!.hrefOf(1)).toBe(`${BASE}?documentsPage=2`);
    expect(documents!.hrefOf(3)).toBe(`${BASE}?page=3&documentsPage=3`);
    expect(documents!.hrefOf(1)).toBe(`${BASE}?page=3`);
  });

  it("reads page 1 for invalid or missing parameters, also without any argument", async () => {
    await navsOf({ page: "abc", documentsPage: ["-1"] });
    expect(load).toHaveBeenLastCalledWith({ page: 1, documentsPage: 1 });
    const [announcements] = await navsOf();
    expect(load).toHaveBeenLastCalledWith({ page: 1, documentsPage: 1 });
    expect(announcements!.hrefOf(2)).toBe(`${BASE}?page=2`);
  });

  it("starts the links from the page shown after a fallback to the last page", async () => {
    load.mockResolvedValue(view(2, 1));
    const [, documents] = await navsOf({ page: "9" });
    expect(documents!.hrefOf(3)).toBe(`${BASE}?page=2&documentsPage=3`);
  });
});
