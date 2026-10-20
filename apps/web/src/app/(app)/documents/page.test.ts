import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The document library links files through mediaUrl() (batch 16 plan S21,
 * WD10): a local upload stays a relative /uploads/… path, so the browser
 * loads it from the web origin through the session-gated proxy, never from
 * the cms host; an external provider's absolute URL stays as it is. The
 * size is Strapi's kilobytes, written for people.
 */
vi.stubEnv("STRAPI_PUBLIC_URL", "https://cms.example");
const viewer = { role: "member" as string | null };
const acksMock = vi.fn();
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewer }));
vi.mock("@/lib/acknowledgements", () => ({ fetchMyDocumentAcks: () => acksMock() }));
vi.mock("@/components/announcements/ack-button", () => ({
  AckButton: (props: {
    targetType: string;
    targetDocumentId: string;
    acknowledgedAtLabel: string | null;
  }) =>
    `[ack ${props.targetType} ${props.targetDocumentId} ${props.acknowledgedAtLabel ?? "open"}]`,
}));
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
          { id: 4, documentId: "docmust", title: "Must read", requiresAck: true, file: null },
          { id: 5, documentId: "docdone", title: "Read", requiresAck: true, file: null },
        ],
      }),
    },
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "1. Oktober 2026" }),
}));

beforeEach(() => {
  viewer.role = "member";
  acksMock.mockReset().mockResolvedValue({
    acks: [
      {
        id: 1,
        targetType: "document",
        targetDocumentId: "docdone",
        acknowledgedAt: "2026-10-01T08:00:00.000Z",
      },
    ],
    truncated: false,
  });
});

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

  it("offers the read confirmation of a mandatory document, with the caller's own receipt (v0.20)", async () => {
    const html = renderToStaticMarkup(await DocumentsPage());
    expect(html).toContain("documents.ackRequired");
    expect(html).toContain("[ack document docmust open]");
    expect(html).toContain("[ack document docdone 1. Oktober 2026]");
  });

  it("shows no confirmation to a guest and does not read receipts", async () => {
    viewer.role = "guest";
    const html = renderToStaticMarkup(await DocumentsPage());
    expect(html).not.toContain("documents.ackRequired");
    expect(html).not.toContain("[ack");
    expect(acksMock).not.toHaveBeenCalled();
  });
});
