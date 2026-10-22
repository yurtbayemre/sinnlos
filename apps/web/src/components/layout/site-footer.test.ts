import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { VERSION } from "@/lib/site-config";

/** v0.26 (M1/M3): the footer under every page, its links from the runtime env. */
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: keyof (typeof en)["footer"]) => en.footer[key],
}));

const { SiteFooter } = await import("./site-footer");

async function render(): Promise<string> {
  return renderToStaticMarkup(await SiteFooter({}));
}

describe("SiteFooter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows the release, the source offer and the notices without any configuration", async () => {
    const html = await render();
    expect(html).toContain(`sinnlos ${VERSION}`);
    expect(html).toContain(
      `<a href="https://github.com/yurtbayemre/sinnlos" class="hover:text-foreground hover:underline">${en.footer.source}</a>`,
    );
    expect(html).toContain(`href="/THIRD_PARTY_NOTICES.txt"`);
    expect(html).not.toContain(en.footer.privacy);
    expect(html).not.toContain(en.footer.imprint);
    expect(html).not.toContain(en.footer.whistleblowing);
  });

  it("adds the configured legal links and the image's revision", async () => {
    vi.stubEnv("PRIVACY_URL", "https://example.com/privacy");
    vi.stubEnv("IMPRINT_URL", "https://example.com/imprint");
    vi.stubEnv("WHISTLEBLOWING_URL", "https://report.example.com/");
    vi.stubEnv("SINNLOS_REVISION", "0c26656e98f9");
    const html = await render();
    expect(html).toContain(`sinnlos ${VERSION} (0c26656)`);
    expect(html).toContain(`href="https://example.com/privacy"`);
    expect(html).toContain(`href="https://example.com/imprint"`);
    expect(html).toContain(`href="https://report.example.com/"`);
  });
});
