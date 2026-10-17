import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ActivityList, ActivityPagination } from "@/components/manage/activity";
import type { ActivityListRow } from "@sinnlos/domain";

const state = vi.hoisted(() => ({ role: "admin_role", strapi: vi.fn() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => ({ role: state.role }) }));
vi.mock("@/lib/strapi/client", () => ({ strapi: state.strapi }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const { default: Page } = await import("./page");
const render = (params: Record<string, string> = {}) =>
  Page({ searchParams: Promise.resolve(params) });
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}
const empty = { data: [], meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total: 0 } } };
beforeEach(() => {
  state.role = "admin_role";
  state.strapi.mockReset().mockResolvedValue(empty);
});

it.each(["editor", "department_head", "team_lead", "member", "guest", "authenticated"])(
  "refuses %s before reading activity",
  async (role) => {
    state.role = role;
    await expect(render()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;replace;/;"),
    });
    expect(state.strapi).not.toHaveBeenCalled();
  },
);

it("shows empty state and exact pagination for an empty success", async () => {
  const tree = elements(await render());
  expect(tree.some((el) => el.type === EmptyState)).toBe(true);
  expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(false);
  expect(tree.find((el) => el.type === ActivityPagination)?.props.pagination).toEqual(
    empty.meta.pagination,
  );
});

it("passes the fixed actor DTO to the activity list", async () => {
  const row: ActivityListRow = {
    id: 1,
    createdAt: "2026-10-17T12:00:00Z",
    action: "delete",
    targetUid: "plugin::upload.file",
    targetDocumentId: "42",
    revision: null,
    source: "system",
    keys: [],
    detail: null,
    actor: { kind: "user", id: 7, displayName: "Deleted user #7", class: null },
  };
  state.strapi.mockResolvedValueOnce({ ...empty, data: [row] });
  const tree = elements(await render());
  expect(tree.find((el) => el.type === ActivityList)?.props.rows).toEqual([row]);
  expect(tree.some((el) => el.type === EmptyState)).toBe(false);
});

it("shows the failure banner without a false empty or total on outage", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.strapi.mockRejectedValueOnce(new Error("offline"));
  const tree = elements(await render());
  expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
  expect(tree.some((el) => el.type === EmptyState || el.type === ActivityPagination)).toBe(false);
  vi.restoreAllMocks();
});

it("shows a filter error without reading or rendering a false empty state", async () => {
  const tree = elements(await render({ actorId: "7" }));
  expect(tree.some((el) => el.props.role === "alert")).toBe(true);
  expect(tree.some((el) => el.type === EmptyState || el.type === ActivityPagination)).toBe(false);
  expect(state.strapi).not.toHaveBeenCalled();
});
