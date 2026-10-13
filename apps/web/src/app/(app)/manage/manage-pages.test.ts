import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchErrorBanner } from "@/components/fetch-error";
import { EmptyState } from "@/components/empty-state";
import { AnnouncementEditor } from "@/components/manage/announcement-editor";
import { EventEditor } from "@/components/manage/event-editor";
import { ManageFlashProvider } from "@/components/manage/flash";
import { ManageListPage } from "@/components/manage/list-page";
import { NoDepartmentExplanation } from "@/components/manage/page-parts";
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
  it("an editor: the four area tiles, no reports and no Strapi links", async () => {
    const tree = elements(await ManagePage());
    expect(hrefs(tree)).toEqual(
      expect.arrayContaining([
        "/manage/announcements",
        "/manage/events",
        "/manage/polls",
        "/manage/quick-links",
      ]),
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

  it("a department head: announcements and events only (no documents tile before 16C)", async () => {
    viewerRef.current = viewer("department_head", ENG);
    const tree = elements(await ManagePage());
    const areas = hrefs(tree).filter((href) => href.startsWith("/manage/"));
    expect(areas.sort()).toEqual(["/manage/announcements", "/manage/events"]);
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

describe("/polls/new", () => {
  it("redirects to /manage/polls/new", async () => {
    expect(await redirectOf(() => NewPollRedirect())).toBe("/manage/polls/new");
  });
});
