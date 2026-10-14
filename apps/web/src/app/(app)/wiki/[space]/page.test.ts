import { isValidElement, type ReactNode } from "react";
import Link from "next/link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/viewer";

/**
 * A wiki space's actions (batch 16, and 16.1 for issue #79). The space
 * lists its PUBLISHED pages only, so a page an author saved as a draft in
 * it is not below; the space links the caller's drafts for every role that
 * edits wiki pages, next to "New page" (creators) and "Manage this space"
 * (moderators). The page's element tree is searched, not rendered.
 */
const viewerRef: { current: Viewer } = { current: null as unknown as Viewer };

vi.mock("@/lib/strapi", () => ({
  api: {
    wiki: {
      space: async () => ({
        data: [
          {
            id: 1,
            documentId: "s1",
            name: "People & Culture",
            slug: "people-culture",
            visibility: "public",
            pages: [{ id: 3, title: "Onboarding", slug: "onboarding", order: 0 }],
          },
        ],
      }),
    },
  },
}));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewerRef.current }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));

const { default: WikiSpacePage } = await import("./page");

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

const hrefs = async () =>
  elements(await WikiSpacePage({ params: Promise.resolve({ space: "people-culture" }) }))
    .filter((el) => el.type === Link)
    .map((el) => el.props.href);

beforeEach(() => {
  viewerRef.current = viewer("guest");
});

describe("a wiki space's actions", () => {
  it("a department head gets New page and My drafts (issue #79)", async () => {
    viewerRef.current = viewer("department_head");
    const links = await hrefs();
    expect(links).toEqual(
      expect.arrayContaining(["/wiki/people-culture/new?create=1", "/wiki/drafts?mine=1"]),
    );
    expect(links).not.toContain("/manage/wiki/s1");
  });

  it("an editor also manages the space", async () => {
    viewerRef.current = viewer("editor");
    expect(await hrefs()).toEqual(
      expect.arrayContaining([
        "/wiki/people-culture/new?create=1",
        "/wiki/drafts?mine=1",
        "/manage/wiki/s1",
      ]),
    );
  });

  it("a member, who edits their own pages, gets My drafts only", async () => {
    viewerRef.current = viewer("member");
    const links = await hrefs();
    expect(links).toContain("/wiki/drafts?mine=1");
    expect(links).not.toContain("/wiki/people-culture/new?create=1");
  });

  it.each(["guest", null])("%s gets no writing link", async (role) => {
    viewerRef.current = viewer(role);
    const links = await hrefs();
    expect(links).not.toContain("/wiki/drafts?mine=1");
    expect(links).not.toContain("/wiki/people-culture/new?create=1");
    // The published page is listed for every reader.
    expect(links).toContain("/wiki/people-culture/onboarding");
  });
});
