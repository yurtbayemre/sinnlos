import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteClassified } from "@/components/marketplace/delete-classified";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD07: the id-addressed detail pages check the route id before any read
 * (a malformed id is a 404, never a CMS request: Postgres answers the int4
 * lookup with an error, i.e. a 500), an unknown entry is a 404, and a failed
 * read propagates to (app)/error.tsx instead of an inline banner.
 * generateMetadata never fails the page: a failed read gives the section
 * title. The slug pages (course, department, team) need no id check (a
 * varchar comparison never fails) and follow the same rules otherwise.
 *
 * `next/navigation` is the real module (notFound's own error); the CMS
 * client, session, viewer and translations are mocked. The viewer's role
 * and the session user are per test (the ad controls, SH02).
 */
const who = vi.hoisted(() => ({ role: "member" as string | null, userId: null as number | null }));
const strapiMock = vi.fn<(path: string) => Promise<unknown>>();
const classifiedMock = vi.fn<(id: string) => Promise<unknown>>();
const departmentMock = vi.fn<(slug: string) => Promise<unknown>>();
const teamMock = vi.fn<(slug: string) => Promise<unknown>>();
const courseMock = vi.fn<(slug: string) => Promise<unknown>>();
const progressMock = vi.fn<() => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({
  strapi: (path: string) => strapiMock(path),
  api: {
    classifieds: { one: (id: string) => classifiedMock(id) },
    departments: { one: (slug: string) => departmentMock(slug) },
    teams: { one: (slug: string) => teamMock(slug) },
  },
}));
vi.mock("@/lib/training", () => ({
  fetchCourseBySlug: (slug: string) => courseMock(slug),
  fetchMyProgress: () => progressMock(),
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => (who.userId === null ? null : { user: { id: who.userId } }),
}));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: who.userId, displayName: "M", role: who.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getLocale: async () => "en",
}));

const person = await import("./people/[id]/page");
const ad = await import("./marketplace/[id]/page");
const adEdit = await import("./marketplace/[id]/edit/page");
const course = await import("./training/[slug]/page");
const department = await import("./departments/[slug]/page");
const team = await import("./teams/[slug]/page");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const slugParams = (slug: string) => ({ params: Promise.resolve({ slug }) });
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
/** Route ids Postgres would reject in an int4 lookup (or that are no id). */
const MALFORMED = ["abc", "1.5", "1e3", "0", "-1", "01", "2147483648", " 1", ""];

beforeEach(() => {
  who.role = "member";
  who.userId = null;
  strapiMock.mockReset();
  classifiedMock.mockReset();
  departmentMock.mockReset();
  teamMock.mockReset();
  courseMock.mockReset();
  progressMock.mockReset();
  // tryFetch logs every failed read it absorbs.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/people/[id]", () => {
  it.each(MALFORMED)("answers the malformed id %j with 404 and no CMS read", async (id) => {
    await expect(person.default(params(id))).rejects.toMatchObject(NOT_FOUND);
    await expect(person.generateMetadata(params(id))).rejects.toMatchObject(NOT_FOUND);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("reads the canonical id and answers an unknown user (empty body or 404) with 404", async () => {
    strapiMock.mockResolvedValue(undefined);
    await expect(person.default(params("42"))).rejects.toMatchObject(NOT_FOUND);
    expect(strapiMock.mock.calls[0]![0]).toMatch(/^\/api\/users\/42\?/);
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    await expect(person.default(params("42"))).rejects.toMatchObject(NOT_FOUND);
  });

  it("lets a failed read reach the error boundary", async () => {
    const outage = new StrapiError(502, "Bad Gateway", "");
    strapiMock.mockRejectedValue(outage);
    await expect(person.default(params("42"))).rejects.toBe(outage);
  });

  it("titles the page with the person, or the section when the read fails", async () => {
    strapiMock.mockResolvedValue({ id: 42, displayName: "Ada Lovelace" });
    await expect(person.generateMetadata(params("42"))).resolves.toEqual({ title: "Ada Lovelace" });
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    await expect(person.generateMetadata(params("42"))).resolves.toEqual({ title: "nav.people" });
  });
});

describe("/marketplace/[id] and /marketplace/[id]/edit", () => {
  it.each(MALFORMED)("answer the malformed id %j with 404 and no CMS read", async (id) => {
    await expect(ad.default(params(id))).rejects.toMatchObject(NOT_FOUND);
    await expect(ad.generateMetadata(params(id))).rejects.toMatchObject(NOT_FOUND);
    await expect(adEdit.default(params(id))).rejects.toMatchObject(NOT_FOUND);
    expect(classifiedMock).not.toHaveBeenCalled();
  });

  it("answer an unknown ad with 404", async () => {
    classifiedMock.mockResolvedValue({ data: [] });
    await expect(ad.default(params("7"))).rejects.toMatchObject(NOT_FOUND);
    await expect(adEdit.default(params("7"))).rejects.toMatchObject(NOT_FOUND);
    expect(classifiedMock).toHaveBeenCalledWith("7");
  });

  it("let a failed read reach the error boundary", async () => {
    const outage = new StrapiError(500, "Internal Server Error", "");
    classifiedMock.mockRejectedValue(outage);
    await expect(ad.default(params("7"))).rejects.toBe(outage);
    await expect(adEdit.default(params("7"))).rejects.toBe(outage);
  });

  it("titles the page with the ad, or the section when the read fails", async () => {
    classifiedMock.mockResolvedValue({ data: [{ id: 7, title: "Bike" }] });
    await expect(ad.generateMetadata(params("7"))).resolves.toEqual({ title: "Bike" });
    classifiedMock.mockRejectedValue(new Error("down"));
    await expect(ad.generateMetadata(params("7"))).resolves.toEqual({
      title: "marketplace.title",
    });
  });
});

/** Every element in a returned page tree (host and component elements, through children). */
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

describe("/marketplace/[id] controls (SH02: canEditAnyAd, canDeleteAnyAd)", () => {
  const OWNER = 5;
  const bike = { data: [{ id: 7, title: "Bike", author: { id: OWNER, displayName: "Olga" } }] };
  const controls = async () => {
    const tree = elements(await ad.default(params("7")));
    return {
      edit: tree.some((el) => el.props.href === "/marketplace/7/edit"),
      takeDown: tree.some((el) => el.type === DeleteClassified),
    };
  };

  beforeEach(() => classifiedMock.mockResolvedValue(bike));

  it.each([
    ["the owner edits (and deletes on the edit page)", "member", OWNER, true, false],
    ["an editor takes someone else's ad down but cannot edit it", "editor", 1, false, true],
    ["an admin edits and takes down", "admin_role", 1, true, true],
    ["another member gets neither", "member", 1, false, false],
    ["the `authenticated` fallback gets neither", "authenticated", 1, false, false],
    ["an unreadable role gets neither", null, 1, false, false],
  ])("%s", async (_label, role, userId, edit, takeDown) => {
    who.role = role;
    who.userId = userId;
    await expect(controls()).resolves.toEqual({ edit, takeDown });
  });

  it("takes the ad down with the ad's id and title", async () => {
    who.role = "editor";
    who.userId = 1;
    const tree = elements(await ad.default(params("7")));
    const takedown = tree.find((el) => el.type === DeleteClassified);
    expect(takedown?.props).toMatchObject({ id: 7, title: "Bike" });
  });

  it("the edit page lets an editor through only for their own ad", async () => {
    who.role = "editor";
    who.userId = 1;
    await expect(adEdit.default(params("7"))).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;replace;\/marketplace\/7;/),
    });
    who.role = "admin_role";
    const tree = elements(await adEdit.default(params("7")));
    expect(tree.some((el) => el.type === DeleteClassified)).toBe(true);
  });
});

describe.each([
  {
    route: "/departments/[slug]",
    page: department,
    read: departmentMock,
    section: "departments.title",
  },
  { route: "/teams/[slug]", page: team, read: teamMock, section: "teams.title" },
])("$route", ({ page, read, section }) => {
  it("titles the page with the entry, or the section when the read fails", async () => {
    read.mockResolvedValue({ data: [{ id: 3, name: "Engineering", slug: "engineering" }] });
    await expect(page.generateMetadata(slugParams("engineering"))).resolves.toEqual({
      title: "Engineering",
    });
    expect(read).toHaveBeenCalledWith("engineering");
    read.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    await expect(page.generateMetadata(slugParams("engineering"))).resolves.toEqual({
      title: section,
    });
  });

  it("answers an unknown slug with 404", async () => {
    read.mockResolvedValue({ data: [] });
    await expect(page.default(slugParams("nope"))).rejects.toMatchObject(NOT_FOUND);
    await expect(page.generateMetadata(slugParams("nope"))).resolves.toEqual({ title: section });
  });

  it("lets a failed read reach the error boundary", async () => {
    const outage = new StrapiError(502, "Bad Gateway", "");
    read.mockRejectedValue(outage);
    await expect(page.default(slugParams("engineering"))).rejects.toBe(outage);
  });
});

describe("/training/[slug]", () => {
  const security = { id: 1, title: "Security basics", slug: "security", lessons: [] };

  it("titles the page with the course, or the section when the read fails", async () => {
    courseMock.mockResolvedValue(security);
    await expect(course.generateMetadata(slugParams("security"))).resolves.toEqual({
      title: "Security basics",
    });
    expect(courseMock).toHaveBeenCalledWith("security");
    courseMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    await expect(course.generateMetadata(slugParams("security"))).resolves.toEqual({
      title: "training.title",
    });
  });

  it("answers an unknown course with 404", async () => {
    courseMock.mockResolvedValue(null);
    progressMock.mockResolvedValue({ completed: new Map(), truncated: false });
    await expect(course.default(slugParams("nope"))).rejects.toMatchObject(NOT_FOUND);
    await expect(course.generateMetadata(slugParams("nope"))).resolves.toEqual({
      title: "training.title",
    });
  });

  it("lets a failed course read reach the error boundary", async () => {
    const outage = new StrapiError(502, "Bad Gateway", "");
    courseMock.mockRejectedValue(outage);
    progressMock.mockResolvedValue({ completed: new Map(), truncated: false });
    await expect(course.default(slugParams("security"))).rejects.toBe(outage);
  });

  it("renders without the caller's progress, the status unknown", async () => {
    courseMock.mockResolvedValue(security);
    progressMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const html = renderToStaticMarkup(await course.default(slugParams("security")));
    expect(html).toContain("Security basics");
    expect(html).toContain('<span class="text-muted-foreground">–</span>');
  });
});
