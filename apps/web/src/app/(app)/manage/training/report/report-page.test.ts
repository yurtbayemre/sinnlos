import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ListPageSkeleton } from "@/components/skeletons";

const state = vi.hoisted(() => ({
  role: "admin_role",
  courses: vi.fn(),
  users: vi.fn(),
  progress: vi.fn(),
}));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => ({ role: state.role }) }));
vi.mock("@/lib/training", () => ({
  fetchCourses: state.courses,
  fetchCourseProgress: state.progress,
}));
vi.mock("@/lib/users", () => ({ fetchAllUsers: state.users }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "" }),
}));
const { default: Page } = await import("./page");
const { default: Loading } = await import("./loading");
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}
beforeEach(() => {
  state.role = "admin_role";
  state.courses.mockReset().mockResolvedValue({ courses: [], truncated: false });
  state.users.mockReset().mockResolvedValue({ users: [], truncated: false });
  state.progress.mockReset();
});

it.each(["editor", "department_head", "team_lead", "member", "guest", "authenticated"])(
  "keeps the relocated report admin-only for %s",
  async (role) => {
    state.role = role;
    await expect(Page()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;replace;/;"),
    });
    expect(state.courses).not.toHaveBeenCalled();
    expect(state.users).not.toHaveBeenCalled();
  },
);
it("renders the existing report at its new route", async () => {
  const tree = elements(await Page());
  expect(tree.some((el) => el.type === EmptyState)).toBe(true);
  expect(state.courses).toHaveBeenCalledOnce();
  expect(state.users).toHaveBeenCalledOnce();
});
it("still refuses to show numbers when a report input fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.courses.mockRejectedValueOnce(new Error("offline"));
  const tree = elements(await Page());
  expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
  expect(tree.some((el) => el.type === EmptyState)).toBe(false);
  vi.restoreAllMocks();
});
it("has its own loading skeleton", () => {
  expect(Loading().type).toBe(ListPageSkeleton);
});
