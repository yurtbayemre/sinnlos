import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { NoDepartmentExplanation } from "@/components/manage/page-parts";
import { ListPageSkeleton } from "@/components/skeletons";
import { StrapiError } from "@/lib/strapi-error";

/**
 * The named training report pages (v0.20): the summary and one course.
 * Pinned: who may open them (admin_role, department heads, team leads), a
 * head or lead without a department gets the explanation and no read, an
 * outage gets the banner, the cms's 404 a 404, and the status filter.
 */
const state = vi.hoisted(() => ({
  role: "admin_role",
  department: null as { name: string } | null,
  summary: vi.fn(),
  course: vi.fn(),
}));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ role: state.role, department: state.department }),
}));
vi.mock("@/lib/api/training", () => ({
  trainingReport: state.summary,
  courseTrainingReport: state.course,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "" }),
  getLocale: async () => "de",
}));
const { default: Page } = await import("./page");
const { default: Loading } = await import("./loading");
const { default: CoursePage } = await import("./[course]/page");

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const person = (userId: number, status: string) => ({
  userId,
  name: `P${userId}`,
  email: null,
  department: "Lager",
  status,
  completed: 0,
  total: 1,
  completedAt: null,
  dueKey: null,
  receipts: [],
});
const course = {
  documentId: DOC,
  title: "Stapler",
  slug: "stapler",
  validityMonths: 12,
  lessonCount: 1,
  departments: ["Lager"],
  counts: { done: 1, dueSoon: 0, expired: 1, open: 0, total: 2 },
};
const openCourse = (status?: string) =>
  CoursePage({
    params: Promise.resolve({ course: DOC }),
    searchParams: Promise.resolve(status ? { status } : {}),
  });

beforeEach(() => {
  state.role = "admin_role";
  state.department = null;
  state.summary
    .mockReset()
    .mockResolvedValue({ data: { scope: "all", department: null, courses: [] } });
  state.course.mockReset().mockResolvedValue({
    data: {
      scope: "all",
      department: null,
      course,
      lessons: [],
      people: [person(1, "expired"), person(2, "done")],
    },
  });
});

it.each(["editor", "member", "guest", "authenticated"])(
  "keeps the report from %s",
  async (role) => {
    state.role = role;
    for (const render of [() => Page(), () => openCourse()]) {
      await expect(render()).rejects.toMatchObject({
        digest: expect.stringContaining("NEXT_REDIRECT;replace;/;"),
      });
    }
    expect(state.summary).not.toHaveBeenCalled();
    expect(state.course).not.toHaveBeenCalled();
  },
);

it("opens the report to heads and leads with a department", async () => {
  for (const role of ["department_head", "team_lead"]) {
    state.role = role;
    state.department = { name: "Lager" };
    elements(await Page());
  }
  expect(state.summary).toHaveBeenCalledTimes(2);
});

it("explains a missing department instead of reading", async () => {
  state.role = "team_lead";
  for (const render of [() => Page(), () => openCourse()]) {
    expect(elements(await render()).some((el) => el.type === NoDepartmentExplanation)).toBe(true);
  }
  expect(state.summary).not.toHaveBeenCalled();
  expect(state.course).not.toHaveBeenCalled();
});

it("shows the empty state, and a banner on an outage", async () => {
  expect(elements(await Page()).some((el) => el.type === EmptyState)).toBe(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.summary.mockRejectedValueOnce(new Error("offline"));
  const tree = elements(await Page());
  expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
  expect(tree.some((el) => el.type === EmptyState)).toBe(false);
  vi.restoreAllMocks();
});

it("lists one course's people, filtered by status", async () => {
  const rows = (tree: ReturnType<typeof elements>) => tree.filter((el) => el.type === "tr").length;
  // Header row plus one per person.
  expect(rows(elements(await openCourse()))).toBe(3);
  expect(rows(elements(await openCourse("expired")))).toBe(2);
  expect(rows(elements(await openCourse("bogus")))).toBe(3);
  expect(state.course).toHaveBeenCalledWith(DOC, { leavers: false });
});

it("adds the people who left for an admin who asks, never for a head (v0.28)", async () => {
  const leaver = { ...person(9, "done"), left: "anonymised" as const };
  state.course.mockResolvedValue({
    data: {
      scope: "all",
      department: null,
      course,
      lessons: [],
      people: [person(1, "expired"), person(2, "done")],
      leavers: [leaver],
    },
  });
  const withLeavers = () =>
    CoursePage({
      params: Promise.resolve({ course: DOC }),
      searchParams: Promise.resolve({ leavers: "1" }),
    });
  const rows = (tree: ReturnType<typeof elements>) => tree.filter((el) => el.type === "tr").length;
  // Two tables: header + two people, header + one leaver.
  expect(rows(elements(await withLeavers()))).toBe(5);
  expect(state.course).toHaveBeenLastCalledWith(DOC, { leavers: true });
  state.role = "department_head";
  state.department = { name: "Lager" };
  await withLeavers();
  expect(state.course).toHaveBeenLastCalledWith(DOC, { leavers: false });
});

it("answers 404 for the cms's 404 and a malformed id", async () => {
  state.course.mockRejectedValueOnce(new StrapiError(404, "Not Found", ""));
  await expect(openCourse()).rejects.toMatchObject({
    digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404"),
  });
  await expect(
    CoursePage({ params: Promise.resolve({ course: "../x" }), searchParams: Promise.resolve({}) }),
  ).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404") });
});

it("has its own loading skeleton", () => {
  expect(Loading().type).toBe(ListPageSkeleton);
});
