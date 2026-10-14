import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchErrorBanner } from "@/components/fetch-error";
import { EmptyState } from "@/components/empty-state";
import { AnnouncementEditor } from "@/components/manage/announcement-editor";
import { DocumentEditor } from "@/components/manage/document-editor";
import { EventEditor } from "@/components/manage/event-editor";
import { ManageFlashProvider } from "@/components/manage/flash";
import { ManageListPage } from "@/components/manage/list-page";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import { StatCount } from "@/components/ui/stat-tile";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";

/**
 * The /manage pages and their gates (decision 06 §L1, §L2, §N1, §N7; batch
 * 15 plan 15C items 1, 4, 5) with batch 15's capability values (K8): the
 * shell for moderators and department authors, the area pages per
 * `author[area]`, a department author's two areas and the explanation
 * without a department (no request), the banner on an outage (never an
 * empty state or a 0), 404 for an item the cms hides, and /polls/new's
 * redirect. The page trees are searched, not rendered; strapi() is mocked.
 */
const strapiMock = vi.fn();
const viewerRef: { current: Viewer } = { current: null as unknown as Viewer };

vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewerRef.current }));
vi.mock("@/lib/roles", async (original) => {
  const roles = await original<typeof import("@/lib/roles")>();
  const { k8Capabilities } = await import("@/lib/manage/k8-capabilities.test.helper");
  return { ...roles, capabilitiesFor: (role: string | null) => k8Capabilities(roles, role) };
});
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getLocale: async () => "en",
  getFormatter: async () => ({ dateTime: () => "" }),
}));

const { default: ManageLayout } = await import("./layout");
const { default: ManagePage } = await import("./page");
const { default: AnnouncementsPage } = await import("./announcements/page");
const { default: NewEventPage } = await import("./events/new/page");
const { default: EditAnnouncementPage } = await import("./announcements/[documentId]/page");
const { default: NewPollRedirect } = await import("../polls/new/page");
const { default: DocumentsPage } = await import("./documents/page");
const { default: NewDocumentPage } = await import("./documents/new/page");
const { default: EditDocumentPage } = await import("./documents/[documentId]/page");
const { default: ManageWikiPage } = await import("./wiki/page");
const { default: NewWikiSpacePage } = await import("./wiki/new/page");
const { default: ManageWikiSpacePage } = await import("./wiki/[space]/page");
const { default: EditWikiSpacePage } = await import("./wiki/[space]/edit/page");

const ENG = { id: 3, documentId: "deptengineering000000000", name: "Engineering", slug: "eng" };
const DOC = "annc00000000000000000001";
const viewer = (role: string, department: Viewer["department"] = null): Viewer => ({
  id: 7,
  displayName: "Ada",
  role,
  department,
});

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}
const hrefs = (tree: ReturnType<typeof elements>) =>
  tree.map((el) => el.props.href).filter((href): href is string => typeof href === "string");

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

const page = (rows: unknown[], total = rows.length) => ({
  data: rows,
  meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total } },
});

beforeEach(() => {
  strapiMock.mockReset().mockResolvedValue(page([]));
  viewerRef.current = viewer("editor");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the /manage shell", () => {
  it.each(["member", "team_lead", "guest", "authenticated"])("sends %s home", async (role) => {
    viewerRef.current = viewer(role);
    expect(await redirectOf(() => ManageLayout({ children: null }))).toBe("/");
    expect(await redirectOf(() => ManagePage())).toBe("/");
  });

  it("opens to moderators and department heads, with the flash region", async () => {
    for (const current of [
      viewer("editor"),
      viewer("admin_role"),
      viewer("department_head", ENG),
    ]) {
      viewerRef.current = current;
      const tree = elements(await ManageLayout({ children: "child" }));
      expect(tree[0]?.type).toBe(ManageFlashProvider);
    }
  });
});

describe("the landing", () => {
  it("an editor: the six area tiles, no reports and no Strapi links", async () => {
    const tree = elements(await ManagePage());
    expect(
      hrefs(tree)
        .filter((href) => href.startsWith("/manage/") && !href.includes("?"))
        .sort(),
    ).toEqual(
      [
        "/manage/announcements",
        "/manage/events",
        "/manage/polls",
        "/manage/quick-links",
        "/manage/documents",
        "/manage/wiki",
      ].sort(),
    );
    expect(hrefs(tree)).not.toContain("/manage/analytics");
    expect(hrefs(tree).some((href) => href.includes("/admin"))).toBe(false);
  });

  it("an admin also gets the reports and the Strapi links", async () => {
    viewerRef.current = viewer("admin_role");
    const tree = elements(await ManagePage());
    expect(hrefs(tree)).toEqual(
      expect.arrayContaining(["/manage/analytics", "/manage/acknowledgements", "/manage/training"]),
    );
    expect(hrefs(tree).some((href) => href.includes("/admin/content-manager"))).toBe(true);
  });

  it("a department head: announcements, events and documents only (§L1), never the wiki", async () => {
    viewerRef.current = viewer("department_head", ENG);
    const tree = elements(await ManagePage());
    const areas = hrefs(tree).filter((href) => href.startsWith("/manage/") && !href.includes("?"));
    expect(areas.sort()).toEqual(["/manage/announcements", "/manage/documents", "/manage/events"]);
    // Their counts come from their own lists; the wiki's page list is never asked.
    const paths = strapiMock.mock.calls.map(([path]) => String(path));
    expect(paths.some((path) => path.startsWith("/api/documents/authoring"))).toBe(true);
    expect(paths.some((path) => path.startsWith("/api/wiki-"))).toBe(false);
    // Their published counts, one per area, each opening that list's tab (#78).
    expect(paths.filter((path) => path.endsWith("?status=published")).sort()).toEqual([
      "/api/announcements/authoring?status=published",
      "/api/documents/authoring?status=published",
      "/api/events/authoring?status=published",
    ]);
    expect(
      hrefs(tree)
        .filter((href) => href.endsWith("?status=published"))
        .sort(),
    ).toEqual([
      "/manage/announcements?status=published",
      "/manage/documents?status=published",
      "/manage/events?status=published",
    ]);
  });

  it("the wiki tile counts the wiki's pages (drafts, published, scheduled, failed)", async () => {
    await ManagePage();
    const paths = strapiMock.mock.calls.map(([path]) => String(path));
    for (const status of ["draft", "published", "scheduled", "failed"]) {
      expect(paths).toContain(`/api/wiki-pages/authoring?status=${status}`);
      expect(paths).toContain(`/api/documents/authoring?status=${status}`);
    }
  });

  it("an editor: a published count per area; a count with a list tab opens it (#78)", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      page([], path.endsWith("?status=published") ? 5 : 1),
    );
    const tree = elements(await ManagePage());
    const paths = strapiMock.mock.calls.map(([path]) => String(path));
    expect(paths.filter((path) => path.endsWith("?status=published")).sort()).toEqual(
      [
        "/api/announcements/authoring?status=published",
        "/api/documents/authoring?status=published",
        "/api/events/authoring?status=published",
        "/api/polls/authoring?status=published",
        "/api/quick-links/authoring?status=published",
        "/api/wiki-pages/authoring?status=published",
      ].sort(),
    );
    const counts = tree.filter((el) => el.type === StatCount);
    expect(counts.filter((el) => (el.props.count as { value: number }).value === 5)).toHaveLength(
      6,
    );
    // Polls have no status tabs and the wiki lists spaces: those counts are no link.
    const countLinks = hrefs(tree).filter((href) => href.includes("?status="));
    expect(countLinks.filter((href) => href.endsWith("?status=published")).sort()).toEqual([
      "/manage/announcements?status=published",
      "/manage/documents?status=published",
      "/manage/events?status=published",
      "/manage/quick-links?status=published",
    ]);
    expect(countLinks.some((href) => href.startsWith("/manage/polls"))).toBe(false);
    expect(countLinks.some((href) => href.startsWith("/manage/wiki"))).toBe(false);
    expect(countLinks).toContain("/manage/events?status=draft");
    expect(countLinks).toContain("/manage/documents?status=failed");
  });

  it("a department head without a department: the explanation, no request (§N1)", async () => {
    viewerRef.current = viewer("department_head", null);
    const tree = elements(await ManagePage());
    expect(tree.some((el) => el.type === NoDepartmentExplanation)).toBe(true);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("a cms outage: the banner and unknown counts, never 0", async () => {
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const tree = elements(await ManagePage());
    expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
    const counts = tree.filter((el) => el.type === StatCount);
    expect(counts.length).toBeGreaterThan(0);
    for (const count of counts)
      expect(count.props.count).toEqual({ value: null, truncated: false });
  });
});

describe("an area list", () => {
  const searchParams = Promise.resolve({});

  it("is the area's list page", () => {
    const tree = elements(AnnouncementsPage({ searchParams }));
    expect(tree[0]?.type).toBe(ManageListPage);
    expect(tree[0]?.props.area).toBe("announcements");
  });

  it("sends a role without the area back to /manage", async () => {
    viewerRef.current = viewer("department_head", ENG);
    expect(await redirectOf(() => ManageListPage({ area: "polls", searchParams }))).toBe("/manage");
    expect(await redirectOf(() => ManageListPage({ area: "quickLinks", searchParams }))).toBe(
      "/manage",
    );
  });

  it("a department head without a department gets the explanation, without a request", async () => {
    viewerRef.current = viewer("department_head", null);
    const tree = elements(await ManageListPage({ area: "events", searchParams }));
    expect(tree.some((el) => el.type === NoDepartmentExplanation)).toBe(true);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("a cms outage shows the banner, never the empty state", async () => {
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const tree = elements(await ManageListPage({ area: "announcements", searchParams }));
    expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
    expect(tree.some((el) => el.type === EmptyState)).toBe(false);
  });

  it("an empty list shows the empty state with the New link", async () => {
    const tree = elements(await ManageListPage({ area: "announcements", searchParams }));
    expect(tree.some((el) => el.type === EmptyState)).toBe(true);
    expect(strapiMock).toHaveBeenCalledWith("/api/announcements/authoring");
  });
});

describe("create and edit pages", () => {
  it("a department head's new event: their department pinned, no department list read", async () => {
    viewerRef.current = viewer("department_head", ENG);
    const tree = elements(await NewEventPage());
    const editor = tree.find((el) => el.type === EventEditor);
    expect(editor?.props.ownDepartment).toEqual(ENG);
    expect((editor?.props.access as { roleClass: string }).roleClass).toBe("departmentAuthor");
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("an item the cms hides answers 404", async () => {
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    await expect(
      EditAnnouncementPage({ params: Promise.resolve({ documentId: DOC }) }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("the form follows the class the cms names in `editable`", async () => {
    viewerRef.current = viewer("department_head", ENG);
    strapiMock.mockImplementation(async (path: string) =>
      path.endsWith("/editable")
        ? {
            data: {
              documentId: DOC,
              version: "2",
              status: "draft",
              publishedAt: null,
              updatedAt: null,
              roleClass: "departmentAuthor",
              title: "T",
              body: null,
              expiresAt: null,
              department: ENG.documentId,
              team: null,
              audienceRoles: [],
              ownerDepartment: { documentId: ENG.documentId, name: ENG.name },
              needsRetarget: false,
            },
          }
        : page([]),
    );
    const tree = elements(
      await EditAnnouncementPage({ params: Promise.resolve({ documentId: DOC }) }),
    );
    const editor = tree.find((el) => el.type === AnnouncementEditor);
    expect((editor?.props.access as { roleClass: string }).roleClass).toBe("departmentAuthor");
    expect(editor?.props.ownDepartment).toEqual(ENG);
    // A department author's team picker: their department's teams only, no department list.
    expect(
      strapiMock.mock.calls
        .map(([path]) => path)
        .some((p) => String(p).startsWith("/api/departments")),
    ).toBe(false);
  });
});

describe("the documents area (batch 16, lane 16C)", () => {
  const DOCUMENT = "docu00000000000000000001";

  it("is the generic list page", () => {
    const tree = elements(DocumentsPage({ searchParams: Promise.resolve({}) }));
    expect(tree[0]?.type).toBe(ManageListPage);
    expect(tree[0]?.props.area).toBe("documents");
  });

  it("a moderator's list has the owner filter; a department head's asks the cms for theirs", async () => {
    await ManageListPage({
      area: "documents",
      searchParams: Promise.resolve({ owner: "department" }),
    });
    expect(strapiMock).toHaveBeenLastCalledWith("/api/documents/authoring?owner=department");
    viewerRef.current = viewer("department_head", ENG);
    await ManageListPage({
      area: "documents",
      searchParams: Promise.resolve({ owner: "department" }),
    });
    // A department author has no owner filter: the cms scopes the list.
    expect(strapiMock).toHaveBeenLastCalledWith("/api/documents/authoring");
  });

  it("a department head's new document: their department pinned, no department list read", async () => {
    viewerRef.current = viewer("department_head", ENG);
    const tree = elements(await NewDocumentPage());
    const editor = tree.find((el) => el.type === DocumentEditor);
    expect(editor?.props.ownDepartment).toEqual(ENG);
    expect((editor?.props.access as { roleClass: string }).roleClass).toBe("departmentAuthor");
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("a department head without a department gets the explanation on the new and edit pages", async () => {
    viewerRef.current = viewer("department_head", null);
    for (const tree of [
      elements(await NewDocumentPage()),
      elements(await EditDocumentPage({ params: Promise.resolve({ documentId: DOCUMENT }) })),
    ]) {
      expect(tree.some((el) => el.type === NoDepartmentExplanation)).toBe(true);
      expect(tree.some((el) => el.type === DocumentEditor)).toBe(false);
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("a document the cms hides answers the not-found page", async () => {
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    await expect(
      EditDocumentPage({ params: Promise.resolve({ documentId: DOCUMENT }) }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("members, team leads and guests are sent home; the area itself refuses them", async () => {
    for (const role of ["member", "team_lead", "guest"]) {
      viewerRef.current = viewer(role);
      expect(await redirectOf(() => NewDocumentPage())).toBe("/");
    }
  });
});

describe("the wiki area (batch 16, lane 16C)", () => {
  const SPACE = "spce00000000000000000001";
  const searchParams = Promise.resolve({});

  it("department heads go back to /manage; members, team leads and guests home", async () => {
    viewerRef.current = viewer("department_head", ENG);
    expect(await redirectOf(() => ManageWikiPage({ searchParams }))).toBe("/manage");
    expect(await redirectOf(() => NewWikiSpacePage())).toBe("/manage");
    expect(
      await redirectOf(() => ManageWikiSpacePage({ params: Promise.resolve({ space: SPACE }) })),
    ).toBe("/manage");
    for (const role of ["member", "team_lead", "guest"]) {
      viewerRef.current = viewer(role);
      expect(await redirectOf(() => ManageWikiPage({ searchParams }))).toBe("/");
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("a moderator's list reads the spaces' authoring list; an outage is the banner", async () => {
    const tree = elements(await ManageWikiPage({ searchParams: Promise.resolve({ q: "hr" }) }));
    expect(strapiMock).toHaveBeenCalledWith("/api/wiki-spaces/authoring?q=hr");
    const header = tree.find((el) => el.type === ManagePageHeader);
    expect((header?.props.action as { href: string }).href).toBe("/manage/wiki/new");
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const failed = elements(await ManageWikiPage({ searchParams }));
    expect(failed.some((el) => el.type === FetchErrorBanner)).toBe(true);
    expect(failed.some((el) => el.type === EmptyState)).toBe(false);
  });

  it("a space the cms does not know is the not-found page, on the tree and the form", async () => {
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    for (const render of [
      () => ManageWikiSpacePage({ params: Promise.resolve({ space: SPACE }) }),
      () => EditWikiSpacePage({ params: Promise.resolve({ space: SPACE }) }),
    ]) {
      await expect(render()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    }
  });

  it("a space's tree links a new page in the wiki and the space's form", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.endsWith("/editable")
        ? {
            data: {
              documentId: SPACE,
              version: "2",
              status: "published",
              publishedAt: null,
              updatedAt: null,
              roleClass: "moderator",
              name: "Handbook",
              slug: "handbook",
              icon: null,
              description: null,
              visibility: "public",
              allowedRoles: [],
              department: null,
              team: null,
              needsRetarget: false,
              pageCount: 0,
            },
          }
        : page([]),
    );
    const tree = elements(await ManageWikiSpacePage({ params: Promise.resolve({ space: SPACE }) }));
    const header = tree.find((el) => el.type === ManagePageHeader);
    expect((header?.props.action as { href: string }).href).toBe("/wiki/handbook/new?create=1");
    expect(hrefs(tree)).toEqual(
      expect.arrayContaining([`/manage/wiki/${SPACE}/edit`, "/wiki/handbook"]),
    );
    expect(strapiMock).toHaveBeenCalledWith(`/api/wiki-pages/authoring?space=${SPACE}`);
    expect(tree.some((el) => el.type === EmptyState)).toBe(true);
  });
});

describe("/polls/new", () => {
  it("redirects to /manage/polls/new", async () => {
    expect(await redirectOf(() => NewPollRedirect())).toBe("/manage/polls/new");
  });
});
