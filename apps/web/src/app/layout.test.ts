import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

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
vi.mock("next-intl/server", () => ({
  getLocale: async () => "de",
  getMessages: async () => ({}),
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

  /** The children of the rendered <html>'s <head>. */
  async function headChildren(): Promise<
    ReactElement<{ children?: string; name?: string; content?: string }>[]
  > {
    const html = (await RootLayout({ children: null })) as ReactElement<{ children: ReactNode }>;
    const head = ([] as ReactNode[])
      .concat(html.props.children)
      .find((child) => isValidElement(child) && child.type === "head") as
      ReactElement<{ children: ReactNode }> | undefined;
    expect(head).toBeDefined();
    return ([] as ReactNode[]).concat(head!.props.children).filter(isValidElement) as ReactElement<{
      children?: string;
      name?: string;
      content?: string;
    }>[];
  }

  it("writes the accent style only for a valid SITE_ACCENT, from numbers only", async () => {
    const styles = async () =>
      (await headChildren())
        .filter((child) => child.type === "style")
        .map((child) => child.props.children);
    vi.stubEnv("SITE_ACCENT", "");
    expect(await styles()).toEqual([]);

    vi.stubEnv("SITE_ACCENT", "#0f766e");
    const [css] = await styles();
    expect(css).toMatch(/^:root\{[-a-z0-9:.% ;]+\}:root\.dark\{[-a-z0-9:.% ;]+\}$/);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SITE_ACCENT", "#0f766e;}body{display:none");
    expect(await styles()).toEqual([]);
    warn.mockRestore();
  });

  it("states the referrer policy in the first element of <head>, with or without branding", async () => {
    // A request to another origin carries no Referer (a diagram's image shape fetches
    // its picture with none of its own), one to this origin keeps it. A literal tag, not
    // the metadata API: Next streams that after the page's content.
    for (const accent of ["", "#0f766e"]) {
      vi.stubEnv("SITE_ACCENT", accent);
      const [first] = await headChildren();
      expect(first.type).toBe("meta");
      expect(first.props).toEqual({ name: "referrer", content: "same-origin" });
    }
    expect((await generateMetadata()).referrer).toBeUndefined(); // a page's own one (set-password) stays its own
  });
});
