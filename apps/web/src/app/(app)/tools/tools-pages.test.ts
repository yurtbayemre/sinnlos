import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { ProcessViewerLazy } from "@/components/processes/process-viewer-lazy";
import { FetchErrorBanner } from "@/components/fetch-error";
import { StrapiError } from "@/lib/strapi-error";

/**
 * The Tools pages (v1.1): the hub and the process list and detail. Guests get the
 * explanation and no request (SH02); the list asks for metadata only; the detail page
 * follows the detail-page strategy (WD07): a malformed id is a 404 without a request,
 * an unknown id a 404, a failed read goes to error.tsx; the diagram is handed to the
 * lazy viewer as the stored XML, with the description in the page.
 */
const who = vi.hoisted(() => ({ role: "member" as string | null }));
const listMock = vi.fn<() => Promise<unknown>>();
const oneMock = vi.fn<(documentId: string) => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({
  api: { processes: { list: () => listMock(), one: (id: string) => oneMock(id) } },
}));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "V", role: who.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getLocale: async () => "en",
  getFormatter: async () => ({ dateTime: () => "Nov 19, 2026" }),
}));

const hub = await import("./page");
const list = await import("./processes/page");
const detail = await import("./processes/[documentId]/page");

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
const ID = "k3m9x0000000000000000001";
const XML = '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"/>';
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  documentId: ID,
  title: "Wareneingang",
  summary: "Ware annehmen und prüfen.",
  updatedAt: "2026-11-18T10:00:00.000Z",
  department: { id: 3, name: "Engineering", slug: "engineering" },
  ...over,
});
const params = (documentId: string) => ({ params: Promise.resolve({ documentId }) });

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}
const has = (tree: ReturnType<typeof elements>, type: unknown) =>
  tree.some((element) => element.type === type);
const hrefs = (tree: ReturnType<typeof elements>) =>
  tree
    .map((element) => element.props.href)
    .filter((href): href is string => typeof href === "string");

beforeEach(() => {
  who.role = "member";
  listMock.mockReset().mockResolvedValue({ data: [row()], meta: {} });
  oneMock.mockReset().mockResolvedValue({ data: [row({ diagram: XML })] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/tools", () => {
  it("offers a tile per tool to a staff role, without any request", async () => {
    const tree = elements(await hub.default());
    expect(hrefs(tree)).toEqual(["/tools/processes", "/tools/pdf", "/tools/qr"]);
    expect(has(tree, SectionUnavailablePage)).toBe(false);
    expect(listMock).not.toHaveBeenCalled();
  });

  it.each(["guest"])("%s gets the explanation", async (role) => {
    who.role = role;
    const tree = elements(await hub.default());
    expect(has(tree, SectionUnavailablePage)).toBe(true);
    expect(hrefs(tree)).toEqual([]);
  });
});

describe("/tools/processes", () => {
  it("lists the processes, company-wide first, each linking to its page", async () => {
    listMock.mockResolvedValue({
      data: [
        row({
          id: 2,
          documentId: "k3m9x0000000000000000002",
          title: "Onboarding",
          department: null,
        }),
        row(),
      ],
      meta: {},
    });
    const tree = elements(await list.default());
    expect(hrefs(tree)).toEqual([
      "/tools/processes/k3m9x0000000000000000002",
      `/tools/processes/${ID}`,
    ]);
    expect(has(tree, FetchErrorBanner)).toBe(false);
  });

  it("a guest gets the explanation and no request", async () => {
    who.role = "guest";
    expect(has(elements(await list.default()), SectionUnavailablePage)).toBe(true);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("an outage shows the banner, never 'no processes'", async () => {
    listMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const tree = elements(await list.default());
    expect(has(tree, FetchErrorBanner)).toBe(true);
    expect(hrefs(tree)).toEqual([]);
  });
});

describe("/tools/processes/[documentId]", () => {
  it.each(["abc", "1", "k3m9x", "../etc", ""])(
    "answers the malformed id %j with 404 and no CMS read",
    async (id) => {
      await expect(detail.default(params(id))).rejects.toMatchObject(NOT_FOUND);
      await expect(detail.generateMetadata(params(id))).rejects.toMatchObject(NOT_FOUND);
      expect(oneMock).not.toHaveBeenCalled();
    },
  );

  it("answers an unknown id with 404", async () => {
    oneMock.mockResolvedValue({ data: [] });
    await expect(detail.default(params(ID))).rejects.toMatchObject(NOT_FOUND);
  });

  it("lets a failed read propagate to error.tsx, and keeps the title in the metadata", async () => {
    oneMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    await expect(detail.default(params(ID))).rejects.toBeInstanceOf(StrapiError);
    await expect(detail.generateMetadata(params(ID))).resolves.toEqual({
      title: "processes.title",
    });
  });

  it("shows the description and hands the stored XML to the lazy viewer", async () => {
    const tree = elements(await detail.default(params(ID)));
    const viewer = tree.find((element) => element.type === ProcessViewerLazy);
    expect(viewer?.props).toMatchObject({ title: "Wareneingang", xml: XML });
    expect(tree.map((element) => element.props.children)).toContain("Ware annehmen und prüfen.");
    expect(oneMock).toHaveBeenCalledWith(ID);
    await expect(detail.generateMetadata(params(ID))).resolves.toEqual({ title: "Wareneingang" });
  });

  it("hands an empty diagram on as an empty string (the viewer says so)", async () => {
    oneMock.mockResolvedValue({ data: [row({ diagram: null })] });
    const tree = elements(await detail.default(params(ID)));
    expect(tree.find((element) => element.type === ProcessViewerLazy)?.props.xml).toBe("");
  });

  it("a guest gets the explanation and no request", async () => {
    who.role = "guest";
    expect(has(elements(await detail.default(params(ID))), SectionUnavailablePage)).toBe(true);
    expect(await detail.generateMetadata(params(ID))).toEqual({ title: "processes.title" });
    expect(oneMock).not.toHaveBeenCalled();
  });
});
