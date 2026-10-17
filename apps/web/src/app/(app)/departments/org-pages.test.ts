import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrgDescription } from "@/components/org-description";
import { AvatarImage } from "@/components/ui/avatar";
import { FetchErrorBanner } from "@/components/fetch-error";
import { OrgEditor } from "@/components/manage/org-editor";
import type { Viewer } from "@/lib/viewer";

const state = vi.hoisted(() => ({ viewer: {} as Viewer, strapi: vi.fn() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/lib/strapi/client", () => ({ strapi: state.strapi }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const { default: DepartmentPage } = await import("./[slug]/page");
const { default: TeamPage } = await import("../teams/[slug]/page");
const { default: EditDepartmentPage } = await import("./[slug]/edit/page");
const { default: EditTeamPage } = await import("../teams/[slug]/edit/page");
const department = {
  id: 3,
  documentId: "dept00000000000000000001",
  name: "Engineering",
  slug: "eng",
  description: "**New**",
  headerImage: { url: "/uploads/header.png" },
};
const team = {
  id: 8,
  documentId: "team00000000000000000001",
  name: "Platform",
  slug: "platform",
  department,
  lead: { id: 7 },
  description: "<p>Old</p>",
  avatar: { url: "/uploads/avatar.png", formats: { thumbnail: { url: "/uploads/thumb.png" } } },
};
const params = { params: Promise.resolve({ slug: "eng" }) };
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}
beforeEach(() => {
  state.viewer = { id: 7, displayName: "Ada", role: "admin_role", department };
  state.strapi.mockReset().mockImplementation(async (url: string) => ({
    data: [url.startsWith("/api/departments") ? department : team],
  }));
});
describe("organisation reader integration", () => {
  it("displays saved department header and passes description to the safe renderer", async () => {
    const tree = elements(await DepartmentPage(params));
    expect(tree.find((el) => el.type === "img")?.props).toMatchObject({
      src: "/uploads/header.png",
      alt: "",
    });
    expect(tree.find((el) => el.type === OrgDescription)?.props.value).toBe("**New**");
    expect(tree.some((el) => el.props.href === "/departments/eng/edit")).toBe(true);
    expect(state.strapi.mock.calls[0][0]).toContain("populate[headerImage]=true");
  });
  it("displays the saved team avatar thumbnail and permits its lead", async () => {
    state.viewer.role = "team_lead";
    const tree = elements(await TeamPage(params));
    expect(tree.find((el) => el.type === AvatarImage)?.props.src).toBe("/uploads/thumb.png");
    expect(tree.find((el) => el.type === OrgDescription)?.props.value).toBe("<p>Old</p>");
    expect(tree.some((el) => el.props.href === "/teams/platform/edit")).toBe(true);
    expect(state.strapi.mock.calls[0][0]).toContain("populate[avatar]=true");
  });
  it("an editor who is lead sees neither organisation edit link", async () => {
    state.viewer.role = "editor";
    const tree = [...elements(await DepartmentPage(params)), ...elements(await TeamPage(params))];
    expect(
      tree.some((el) => typeof el.props.href === "string" && el.props.href.endsWith("/edit")),
    ).toBe(false);
  });
});
describe("organisation edit pages", () => {
  it.each([
    ["department", EditDepartmentPage, department],
    ["team", EditTeamPage, team],
  ] as const)("renders %s form only from editable", async (type, Page, row) => {
    const editable = {
      ...row,
      version: "4",
      updatedAt: null,
      roleClass: "moderator",
      description: "raw editable\r\n",
    };
    state.strapi.mockResolvedValueOnce({ data: [row] }).mockResolvedValueOnce({ data: editable });
    const tree = elements(await Page(params));
    expect(tree.find((el) => el.type === OrgEditor)?.props).toMatchObject({ type, editable });
  });
  it("a failed identity read renders an error banner, never a form", async () => {
    state.viewer.id = null;
    const tree = elements(await EditDepartmentPage(params));
    expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
    expect(tree.some((el) => el.type === OrgEditor)).toBe(false);
    expect(state.strapi).not.toHaveBeenCalled();
  });
  it("a denied role is not-found before any request", async () => {
    state.viewer.role = "editor";
    await expect(EditTeamPage(params)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(state.strapi).not.toHaveBeenCalled();
  });
});
