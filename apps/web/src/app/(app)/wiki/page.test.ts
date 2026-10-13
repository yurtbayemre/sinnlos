import { isValidElement, type ReactNode } from "react";
import Link from "next/link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/viewer";

/**
 * /wiki at 360 px: the space cards must not widen the page. Below `sm` the
 * grid had no column template, so its items kept `min-width: auto` and a
 * long description (shown with `truncate`) made a card 442 px wide: the
 * page scrolled sideways by 82 px (batch 14 staging walk). The grid's
 * `grid-cols-1` (minmax(0, 1fr)) and the item's `min-w-0` both keep the
 * cards inside the column. The page's element tree is searched, not
 * rendered. Since batch 16 the header links to the caller's drafts (every
 * role that edits wiki pages) and to /manage/wiki (moderators).
 */
const viewerRef: { current: Viewer } = { current: null as unknown as Viewer };

vi.mock("@/lib/strapi", () => ({
  api: {
    wiki: {
      spaces: async () => ({
        data: [
          {
            id: 1,
            documentId: "s1",
            name: "Engineering",
            slug: "engineering",
            visibility: "public",
            description: "A description long enough to need truncating at 360 px ".repeat(4),
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

const { default: WikiHomePage } = await import("./page");

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

beforeEach(() => {
  viewerRef.current = viewer("guest");
});

describe("/wiki on a phone", () => {
  it("gives the space grid one shrinkable column below sm", async () => {
    const tree = elements(await WikiHomePage());
    const grid = tree.find(
      (el) => typeof el.props.className === "string" && /\bgrid\b/.test(el.props.className),
    );
    expect(grid?.props.className).toMatch(/\bgrid-cols-1\b/);
    const cards = tree.filter((el) => el.type === Link);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.props.className).toMatch(/\bmin-w-0\b/);
  });
});

describe("the writing links (batch 16)", () => {
  const hrefs = async () =>
    elements(await WikiHomePage())
      .filter((el) => el.type === Link)
      .map((el) => el.props.href);

  it("an editor gets My drafts and Manage spaces", async () => {
    viewerRef.current = viewer("editor");
    expect(await hrefs()).toEqual(expect.arrayContaining(["/wiki/drafts", "/manage/wiki"]));
  });

  it.each(["member", "team_lead", "department_head"])("a %s gets My drafts only", async (role) => {
    viewerRef.current = viewer(role);
    const links = await hrefs();
    expect(links).toContain("/wiki/drafts");
    expect(links).not.toContain("/manage/wiki");
  });

  it.each(["guest", null])("%s gets neither", async (role) => {
    viewerRef.current = viewer(role);
    const links = await hrefs();
    expect(links).not.toContain("/wiki/drafts");
    expect(links).not.toContain("/manage/wiki");
  });
});
