import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiki reads (FX24, WD05's wiki part): a page view no longer transfers
 * the revision history, author and last editor are field-limited to what
 * the byline renders, and the space view loads each page's title, slug and
 * summary only, no bodies. `@/lib/session`, `@/lib/config` and global
 * fetch are mocked like in strapi.test.ts; only the request URL matters.
 */
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/session", () => ({ getStrapiToken: async () => "jwt" }));
vi.mock("@/lib/config", () => ({ STRAPI_URL: "http://cms.test", DEMO_MODE: false }));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.stubGlobal("fetch", fetchMock);

const { api } = await import("./strapi");

const emptyList = {
  data: [],
  meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } },
};

/** The query parameters of the one request the helper sent, decoded. */
function sentParams(): string[] {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url] = fetchMock.mock.calls[0]!;
  return decodeURIComponent(url.split("?")[1] ?? "").split("&");
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(emptyList), { status: 200 }),
  );
});

describe("api.wiki.page (FX24)", () => {
  it("does not populate the revisions", async () => {
    await api.wiki.page("handbook", "onboarding");
    for (const param of sentParams()) expect(param).not.toContain("revisions");
  });

  it("limits author and last editor to the byline fields", async () => {
    await api.wiki.page("handbook", "onboarding");
    const params = sentParams();
    for (const relation of ["author", "lastEditor"]) {
      const populate = params.filter((p) => p.startsWith(`populate[${relation}]`)).sort();
      expect(populate, relation).toEqual([
        `populate[${relation}][fields][0]=displayName`,
        `populate[${relation}][fields][1]=username`,
      ]);
    }
  });

  it("still filters by space and page slug", async () => {
    await api.wiki.page("hand book", "on/boarding");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("filters[space][slug][$eq]=hand%20book");
    expect(url).toContain("filters[slug][$eq]=on%2Fboarding");
  });
});

describe("api.wiki.space (FX24, WD05, DA02)", () => {
  it("loads the listed page fields only: no bodies, no author, the order to sort by", async () => {
    await api.wiki.space("handbook");
    const populate = sentParams()
      .filter((p) => p.startsWith("populate"))
      .sort();
    expect(populate).toEqual([
      "populate[pages][fields][0]=title",
      "populate[pages][fields][1]=slug",
      "populate[pages][fields][2]=summary",
      "populate[pages][fields][3]=order",
    ]);
  });
});
