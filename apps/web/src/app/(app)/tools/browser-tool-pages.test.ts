import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { PdfTool } from "@/components/tools/pdf-tool";
import { QrTool } from "@/components/tools/qr-tool";

/**
 * /tools/pdf and /tools/qr: the same read gate as the hub, but fail-closed. Every staff role
 * (and the `authenticated` fallback) gets the tool; a guest, a role that could not be read
 * (null after a failed lookup) and a role nobody knows get the explanation, because no later
 * CMS read decides for these pages. Neither page asks the CMS for anything.
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

const pages = [
  ["pdf", await import("./pdf/page"), PdfTool],
  ["qr", await import("./qr/page"), QrTool],
] as const;

function types(node: ReactNode): unknown[] {
  if (Array.isArray(node)) return node.flatMap(types);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node.type, ...types(node.props.children)];
}

beforeEach(() => {
  who.role = "member";
  cmsCalls.mockReset();
});

describe.each(pages)("/tools/%s", (name, page, Tool) => {
  it.each(["admin_role", "editor", "department_head", "team_lead", "member", "authenticated"])(
    "%s gets the tool",
    async (role) => {
      who.role = role;
      const tree = types(await page.default());
      expect(tree).toContain(Tool);
      expect(tree).not.toContain(SectionUnavailablePage);
    },
  );

  it.each([
    ["a guest", "guest"],
    ["a role that could not be read", null],
    ["a role nobody knows", "role_made_by_hand"],
  ])("%s gets the explanation, not the tool", async (_who, role) => {
    who.role = role;
    const tree = types(await page.default());
    expect(tree).toContain(SectionUnavailablePage);
    expect(tree).not.toContain(Tool);
  });

  it("names the page in its metadata and asks the cms for nothing", async () => {
    await expect(page.generateMetadata()).resolves.toEqual({ title: `tools.${name}.title` });
    await page.default();
    expect(cmsCalls).not.toHaveBeenCalled();
  });
});
