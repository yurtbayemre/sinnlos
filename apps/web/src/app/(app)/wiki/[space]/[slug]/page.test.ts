import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiki page's DA02 lists carry accessible names from the catalogs: the
 * tag chips (whose only other label is an aria-hidden icon) as wiki.tags,
 * the table of contents as wiki.contents. The CMS client and the
 * translations are mocked; a translation renders as "namespace.key".
 */
const pageMock = vi.fn<(space: string, slug: string) => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({
  api: { wiki: { page: (space: string, slug: string) => pageMock(space, slug) } },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "29 September 2026" }),
}));

const { default: WikiPage } = await import("./page");

const params = { params: Promise.resolve({ space: "handbook", slug: "setup" }) };
const BODY = "Intro.\n\n## Getting started\n\n## Next steps";

async function render(entry: Record<string, unknown>): Promise<string> {
  pageMock.mockResolvedValue({
    data: [{ id: 1, documentId: "p1", title: "Setup", slug: "setup", body: BODY, ...entry }],
  });
  return renderToStaticMarkup(await WikiPage(params));
}

beforeEach(() => pageMock.mockReset());

describe("/wiki/[space]/[slug] accessible names", () => {
  it("names the tag list and the table of contents from the wiki catalog", async () => {
    const html = await render({ tags: ["onboarding", "linux"] });
    expect(pageMock).toHaveBeenCalledWith("handbook", "setup");
    expect(html).toContain('<ul class="flex flex-wrap gap-1.5" aria-label="wiki.tags">');
    expect(html).toContain('<nav aria-label="wiki.contents"');
    // The page title is the heading, no longer the TOC's name.
    expect(html).not.toContain('aria-label="Setup"');
  });

  it("renders neither list when the page has no tags and turns the contents off", async () => {
    const html = await render({ tags: [], tocEnabled: false });
    expect(html).not.toContain("wiki.tags");
    expect(html).not.toContain("<nav");
  });
});
