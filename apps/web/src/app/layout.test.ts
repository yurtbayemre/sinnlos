import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";

/**
 * The root layout's viewport (issue #71): `viewport-fit=cover`, without
 * which iOS reports every env(safe-area-inset-*) as 0 and the phone tab
 * bar sits on the home indicator; the scale stays the device's. The font
 * loader, which only Next's compiler runs, is stubbed.
 *
 * v0.29 (S1): the title, the icons and the accent style follow the runtime
 * branding keys.
 */
vi.mock("next/font/google", () => ({ Inter: () => ({ variable: "font-inter" }) }));
const CATALOG = vi.hoisted(() => ({
  nav: { home: "Home" },
  markdown: { mermaidDiagram: "Diagram" },
  tools: { title: "Tools", pdf: { title: "PDF" } },
  processes: { title: "Processes" },
  manage: { common: { save: "Save" } },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "de",
  getMessages: async () => CATALOG,
}));

const { default: RootLayout, generateMetadata, viewport } = await import("./layout");

describe("the root viewport", () => {
  it("draws edge to edge at the device's width and scale", () => {
    expect(viewport).toEqual({
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
    });
  });
});

describe("the root branding", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps today's title and the bundled icons without branding keys", async () => {
    vi.stubEnv("SITE_NAME", "");
    vi.stubEnv("SITE_ICON_URL", "");
    const metadata = await generateMetadata();
    expect(metadata.title).toEqual({ default: "Sinnlos Intranet", template: "%s · Sinnlos" });
    expect(JSON.stringify(metadata.icons)).toContain("/favicon.ico");
  });

  it("names the instance and uses its icon", async () => {
    vi.stubEnv("SITE_NAME", "Musterfirma");
    vi.stubEnv("SITE_ICON_URL", "https://cdn.example.com/icon.png");
    const metadata = await generateMetadata();
    expect(metadata.title).toEqual({ default: "Musterfirma", template: "%s · Musterfirma" });
    expect(metadata.icons).toEqual({
      icon: "https://cdn.example.com/icon.png",
      apple: "https://cdn.example.com/icon.png",
    });
  });

  it("leaves the referrer policy to the (app) layout and to a page's own metadata", async () => {
    // A referrer meta here would come before a page's and be replaced by it, but a
    // streamed one comes after: the (app) layout states the default (its test), and
    // set-password says no-referrer for itself.
    expect((await generateMetadata()).referrer).toBeUndefined();
  });

  it("refuses a name with the title placeholder %s", async () => {
    // Next's resolver runs template.replace(/%s/g, pageTitle) over the whole
    // template, so "Acme %s" would show "Sign in · Acme Sign in".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SITE_NAME", "Acme %s");
    const { title } = (await generateMetadata()) as { title: { template: string } };
    expect(title.template).toBe("%s · Sinnlos");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SITE_NAME"));
    warn.mockRestore();
  });

  /** The <head> child of the rendered <html>, if any. */
  async function headOf(): Promise<
    ReactElement<{ children: ReactElement<{ children: string }> }> | undefined
  > {
    const html = (await RootLayout({ children: null })) as ReactElement<{ children: ReactNode }>;
    const children = ([] as ReactNode[]).concat(html.props.children);
    return children.find(
      (child): child is ReactElement<{ children: ReactElement<{ children: string }> }> =>
        isValidElement(child) && child.type === "head",
    );
  }

  it("writes the accent style only for a valid SITE_ACCENT, from numbers only", async () => {
    vi.stubEnv("SITE_ACCENT", "");
    expect(await headOf()).toBeUndefined();

    vi.stubEnv("SITE_ACCENT", "#0f766e");
    const css = (await headOf())!.props.children.props.children;
    expect(css).toMatch(/^:root\{[-a-z0-9:.% ;]+\}:root\.dark\{[-a-z0-9:.% ;]+\}$/);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SITE_ACCENT", "#0f766e;}body{display:none");
    expect(await headOf()).toBeUndefined();
    warn.mockRestore();
  });
});

/** The first element of `type` in a rendered tree (children, nested arrays). */
function findElement(
  node: ReactNode,
  type: unknown,
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return findElement(node.props.children, type);
}

describe("the root message provider", () => {
  it("sends the catalog without the namespaces only /tools reads, and keeps the rest", async () => {
    // Every page carries the catalog inline; app/(app)/tools/layout.tsx gives the /tools
    // subtree the whole one. `markdown` stays: Mermaid renders wherever Markdown does.
    const tree = (await RootLayout({ children: null })) as ReactElement;
    const provider = findElement(tree, NextIntlClientProvider);
    expect(provider).toBeDefined();
    const messages = provider!.props.messages as Record<string, unknown>;
    expect(messages).not.toHaveProperty("tools");
    expect(messages).not.toHaveProperty("processes");
    expect(messages).toEqual({
      nav: CATALOG.nav,
      markdown: CATALOG.markdown,
      manage: CATALOG.manage,
    });
  });
});
