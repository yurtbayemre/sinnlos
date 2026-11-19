import { isValidElement, type ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

/**
 * The /tools subtree gives its client components (the PDF and QR tools, the process
 * viewer) the whole message catalog: the root layout leaves the `tools` and `processes`
 * namespaces out of every page's payload (i18n/messages.ts TOOLS_MESSAGE_NAMESPACES).
 */
const CATALOG = vi.hoisted(() => ({
  nav: { home: "Home" },
  markdown: { mermaidDiagram: "Diagram" },
  tools: { title: "Tools", pdf: { title: "PDF" }, qr: { title: "QR" } },
  processes: { title: "Processes", loadingDiagram: "Loading" },
  manage: { common: { save: "Save" } },
}));
vi.mock("next-intl/server", () => ({ getMessages: async () => CATALOG }));

const { default: ToolsLayout } = await import("./layout");

describe("the /tools layout", () => {
  it("wraps its pages in a provider with the full catalog, the tools namespaces included", async () => {
    const tree = (await ToolsLayout({ children: "the page" })) as ReactElement<{
      messages: unknown;
      children: unknown;
    }>;
    expect(isValidElement(tree)).toBe(true);
    expect(tree.type).toBe(NextIntlClientProvider);
    expect(tree.props.messages).toBe(CATALOG);
    expect(tree.props.messages).toHaveProperty("tools.pdf.title", "PDF");
    expect(tree.props.messages).toHaveProperty("processes.loadingDiagram", "Loading");
    expect(tree.props.children).toBe("the page");
  });
});
