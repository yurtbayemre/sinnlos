import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { PdfTool } from "@/components/tools/pdf-tool";

/**
 * /tools/pdf: the same read gate as the hub (a guest gets the explanation), the tool
 * itself for every staff role, and no data request: the page reads the viewer only.
 */
const who = vi.hoisted(() => ({ role: "member" as string | null }));
const cmsCalls = vi.hoisted(() => vi.fn());

vi.mock("@/lib/strapi", () => ({ api: new Proxy({}, { get: () => cmsCalls }) }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "V", role: who.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

const page = await import("./page");

function types(node: ReactNode): unknown[] {
  if (Array.isArray(node)) return node.flatMap(types);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node.type, ...types(node.props.children)];
}

beforeEach(() => {
  who.role = "member";
  cmsCalls.mockReset();
});

describe("/tools/pdf", () => {
  it.each(["admin_role", "editor", "department_head", "team_lead", "member"])(
    "%s gets the tool",
    async (role) => {
      who.role = role;
      const tree = types(await page.default());
      expect(tree).toContain(PdfTool);
      expect(tree).not.toContain(SectionUnavailablePage);
    },
  );

  it("a guest gets the explanation, not the tool", async () => {
    who.role = "guest";
    const tree = types(await page.default());
    expect(tree).toContain(SectionUnavailablePage);
    expect(tree).not.toContain(PdfTool);
  });

  it("names the page in its metadata and asks the cms for nothing", async () => {
    await expect(page.generateMetadata()).resolves.toEqual({ title: "tools.pdf.title" });
    await page.default();
    expect(cmsCalls).not.toHaveBeenCalled();
  });
});
