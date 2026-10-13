import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The document library links files through mediaUrl() (batch 16 plan S21,
 * WD10): a local upload stays a relative /uploads/… path, so the browser
 * loads it from the web origin through the session-gated proxy, never from
 * the cms host; an external provider's absolute URL stays as it is. The
 * size is Strapi's kilobytes, written for people.
 */
vi.stubEnv("STRAPI_PUBLIC_URL", "https://cms.example");
vi.mock("@/lib/strapi", () => ({
  api: {
    documents: {
      list: async () => ({
        data: [
          {
            id: 1,
            title: "Travel policy",
            category: "policy",
            file: { url: "/uploads/travel_ab12.pdf", name: "travel.pdf", size: 2048 },
          },
          {
            id: 2,
            title: "Form",
            category: "form",
            file: { url: "https://bucket.example/form.pdf", name: "form.pdf", size: 1 },
          },
          { id: 3, title: "Nothing", category: "other", file: null },
        ],
      }),
    },
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "" }),
}));

const { default: DocumentsPage } = await import("./page");

describe("/documents", () => {
  it("links a local file relative (the /uploads proxy) and an external one as it is", async () => {
    const html = renderToStaticMarkup(await DocumentsPage());
    expect(html).toContain('href="/uploads/travel_ab12.pdf"');
    expect(html).not.toContain("https://cms.example/uploads");
    expect(html).toContain('href="https://bucket.example/form.pdf"');
    expect(html).toContain("2.0 MB");
    expect(html).toContain("documents.noFile");
  });
});
