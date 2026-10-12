import { isValidElement, type ReactNode } from "react";
import Link from "next/link";
import { describe, expect, it, vi } from "vitest";

/**
 * /wiki at 360 px: the space cards must not widen the page. Below `sm` the
 * grid had no column template, so its items kept `min-width: auto` and a
 * long description (shown with `truncate`) made a card 442 px wide: the
 * page scrolled sideways by 82 px (batch 14 staging walk). The grid's
 * `grid-cols-1` (minmax(0, 1fr)) and the item's `min-w-0` both keep the
 * cards inside the column. The page's element tree is searched, not
 * rendered.
 */
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
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

const { default: WikiHomePage } = await import("./page");

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

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
