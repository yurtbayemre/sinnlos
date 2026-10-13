import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/viewer";

/**
 * The wiki page: the DA02 lists carry accessible names from the catalogs
 * (the tag chips, whose only other label is an aria-hidden icon, as
 * wiki.tags; the table of contents as wiki.contents), and since batch 16
 * the Edit and History buttons follow the cms's own row rule (K17,
 * classifyWikiEditor) per role: moderators on every page, the author, the
 * head of the page's department and the lead of its team; a role whose
 * read could not deliver an id the rule needs falls back to its capability
 * (the editor's `editable` decides). The CMS client, the viewer and the
 * translations are mocked; a translation renders as "namespace.key".
 */
const pageMock = vi.fn<(space: string, slug: string) => Promise<unknown>>();
const viewerRef: { current: Viewer } = { current: null as unknown as Viewer };

vi.mock("@/lib/strapi", () => ({
  api: { wiki: { page: (space: string, slug: string) => pageMock(space, slug) } },
}));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewerRef.current }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "29 September 2026" }),
}));

const { default: WikiPage } = await import("./page");

const params = { params: Promise.resolve({ space: "handbook", slug: "setup" }) };
const BODY = "Intro.\n\n## Getting started\n\n## Next steps";
const DOC = "page00000000000000000001";

const viewer = (role: string | null, id = 7, departmentId: number | null = null): Viewer => ({
  id,
  displayName: "Ada",
  role,
  department: departmentId
    ? { id: departmentId, documentId: "deptengineering000000000", name: "Eng", slug: "eng" }
    : null,
});

async function render(entry: Record<string, unknown>): Promise<string> {
  pageMock.mockResolvedValue({
    data: [{ id: 1, documentId: DOC, title: "Setup", slug: "setup", body: BODY, ...entry }],
  });
  return renderToStaticMarkup(await WikiPage(params));
}

/** The page's relations as a full read delivers them. */
const PAGE = {
  author: { id: 11, displayName: "Author" },
  department: { id: 3, name: "Engineering" },
  team: { id: 5, name: "Platform", lead: { id: 12 } },
};

const editLink = `href="/wiki/handbook/setup/edit?doc=${DOC}"`;
const historyLink = `href="/wiki/handbook/setup/history?doc=${DOC}"`;

beforeEach(() => {
  pageMock.mockReset();
  viewerRef.current = viewer("guest");
});

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

describe("Edit and History (classify, K17)", () => {
  it.each([
    ["a moderator (editor)", viewer("editor", 99)],
    ["a moderator (admin)", viewer("admin_role", 99)],
    ["the author (a member)", viewer("member", 11)],
    ["the head of the page's department", viewer("department_head", 98, 3)],
    ["the lead of the page's team", viewer("team_lead", 12)],
  ])("%s gets both buttons", async (_name, current) => {
    viewerRef.current = current;
    const html = await render(PAGE);
    expect(html).toContain(editLink);
    expect(html).toContain(historyLink);
    expect(html).toContain('role="group" aria-label="wiki.pageActions"');
  });

  it.each([
    ["another member", viewer("member", 50)],
    ["another department's head", viewer("department_head", 50, 4)],
    ["another team's lead", viewer("team_lead", 50)],
    ["a member who leads nothing (the lead class is team_lead's)", viewer("member", 12)],
    ["a guest", viewer("guest", 11)],
    ["a viewer the cms could not read", viewer(null, 11)],
  ])("%s gets neither", async (_name, current) => {
    viewerRef.current = current;
    const html = await render(PAGE);
    expect(html).not.toContain(editLink);
    expect(html).not.toContain(historyLink);
  });

  it("falls back to the capability when the read dropped a relation the rule needs", async () => {
    // A team lead whose role may not read the team's lead: the key is missing.
    viewerRef.current = viewer("team_lead", 50);
    expect(await render({ ...PAGE, team: { id: 5, name: "Platform" } })).toContain(editLink);
    // An author whose page read came without the author.
    viewerRef.current = viewer("member", 50);
    expect(await render({ department: null, team: null })).toContain(editLink);
    // A known "no team" never falls back.
    viewerRef.current = viewer("team_lead", 50);
    expect(await render({ ...PAGE, team: null })).not.toContain(editLink);
    // A guest never edits, whatever the read held.
    viewerRef.current = viewer("guest", 50);
    expect(await render({})).not.toContain(editLink);
  });
});
