import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The optional Meilisearch path of the live search (v0.21): Meilisearch only
 * ranks; candidates are read through the Strapi paths by documentId (the
 * read policies decide), ordered by rank, filled up from the `$containsi`
 * search, and any Meilisearch failure falls back to the search before.
 */

const strapiMock = vi.fn<(path: string) => Promise<unknown>>();
const config = vi.hoisted(() => ({ demo: false }));

vi.mock("@/lib/strapi", () => ({ strapi: (path: string) => strapiMock(path) }));
vi.mock("@/lib/config", () => ({
  get DEMO_MODE() {
    return config.demo;
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "de",
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

const { meiliCandidates, resetMeiliPause, MEILI_CANDIDATES } = await import("./search-meili");
const { searchLive, liveSearchPaths, candidatePath } = await import("./search-action");

const ON = {
  MEILISEARCH_ENABLED: "1",
  MEILISEARCH_URL: "http://sinnlos-meili:7700/",
  MEILISEARCH_SEARCH_KEY: "s",
};

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  resetMeiliPause();
  strapiMock.mockReset();
  config.demo = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("meiliCandidates", () => {
  it("asks nothing while off or incomplete", async () => {
    const fetchImpl = vi.fn();
    for (const env of [
      {},
      { ...ON, MEILISEARCH_ENABLED: "0" },
      { ...ON, MEILISEARCH_SEARCH_KEY: "" },
    ]) {
      expect(await meiliCandidates("brand", env, fetchImpl as never)).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends one ranked query per indexed kind and returns the documentIds in order", async () => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      answer({
        results: [
          { hits: [{ documentId: "a2" }, { documentId: "a1" }] },
          { hits: [] },
          { hits: [{ documentId: "d1" }, { title: "no id" }] },
          { hits: [] },
          { hits: [] },
        ],
      }),
    );
    const ids = await meiliCandidates("brandshutz", ON, fetchImpl as never);
    expect(ids?.get("announcement")).toEqual(["a2", "a1"]);
    expect(ids?.get("document")).toEqual(["d1"]);
    expect(ids?.get("poll")).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://sinnlos-meili:7700/multi-search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s");
    const body = JSON.parse(String(init.body));
    expect(body.queries).toHaveLength(5);
    expect(body.queries[0]).toEqual({
      indexUid: "sinnlos_search",
      q: "brandshutz",
      filter: 'kind = "announcement"',
      limit: MEILI_CANDIDATES,
      attributesToRetrieve: ["documentId"],
    });
  });

  it("answers null on an error and pauses before asking again", async () => {
    const failing = vi.fn(async () => answer({}, 503));
    expect(await meiliCandidates("brand", ON, failing as never)).toBeNull();
    expect(await meiliCandidates("brand", ON, failing as never)).toBeNull();
    expect(failing).toHaveBeenCalledOnce();
    resetMeiliPause();
    const broken = vi.fn(async () => answer({ results: [] }));
    expect(await meiliCandidates("brand", ON, broken as never)).toBeNull();
    resetMeiliPause();
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await meiliCandidates("brand", ON, down as never)).toBeNull();
  });
});

const row = (documentId: string, title = documentId) => ({ id: 1, documentId, title });

describe("searchLive with Meilisearch", () => {
  const ranked = (ids: Partial<Record<string, string[]>>) => async () =>
    new Map(
      ["announcement", "wiki-page", "document", "event", "poll"].map((kind) => [
        kind,
        ids[kind] ?? [],
      ]),
    ) as never;

  it("reads the candidates through Strapi by documentId and keeps Meilisearch's order", async () => {
    const ids = ["a3", "a1", "a2", "a5", "a4", "a6"];
    strapiMock.mockImplementation(async (path) =>
      path === candidatePath("announcement", ids)
        ? // Strapi answers in its own order and drops a6 (not readable for this viewer).
          { data: ["a1", "a2", "a3", "a4", "a5"].map((id) => row(id)) }
        : { data: [] },
    );
    const items = await searchLive("Brand", async () => "member", ranked({ announcement: ids }));
    expect(items.filter((i) => i.kind === "announcement").map((i) => i.key)).toEqual([
      "announcement:a3",
      "announcement:a1",
      "announcement:a2",
      "announcement:a5",
      "announcement:a4",
    ]);
    // Full: no fill-up query for announcements.
    expect(strapiMock).not.toHaveBeenCalledWith(liveSearchPaths("Brand", null).announcement);
  });

  it("fills fewer than five readable candidates from the $containsi search, without duplicates", async () => {
    const legacy = liveSearchPaths("Brand", null).document;
    strapiMock.mockImplementation(async (path) => {
      if (path === candidatePath("document", ["d9"])) return { data: [row("d9")] };
      if (path === legacy) return { data: [row("d1"), row("d9")] };
      return { data: [] };
    });
    const items = await searchLive("Brand", async () => "member", ranked({ document: ["d9"] }));
    expect(items.filter((i) => i.kind === "document").map((i) => i.key)).toEqual([
      "document:d9",
      "document:d1",
    ]);
  });

  it("is exactly the search before when Meilisearch answers null or in demo mode", async () => {
    strapiMock.mockResolvedValue({ data: [] });
    await searchLive(
      "Brand",
      async () => "member",
      async () => null,
    );
    const before = strapiMock.mock.calls.map(([path]) => path).sort();
    const paths = liveSearchPaths("Brand", "member");
    expect(before).toEqual(Object.values(paths).sort());

    strapiMock.mockClear();
    config.demo = true;
    const candidates = vi.fn();
    await searchLive("Brand", async () => "member", candidates as never);
    expect(candidates).not.toHaveBeenCalled();
  });

  it("never asks Meilisearch for people and keeps role-gated kinds unread", async () => {
    strapiMock.mockResolvedValue({ data: [] });
    await searchLive("Brand", async () => "guest", ranked({ announcement: ["a1"] }));
    const asked = strapiMock.mock.calls.map(([path]) => path);
    expect(asked.some((path) => path.startsWith("/api/announcements"))).toBe(false);
    expect(asked.some((path) => path.startsWith("/api/users?"))).toBe(true);
  });
});

describe("candidatePath", () => {
  it("filters by documentId with the live search's fields", () => {
    expect(candidatePath("poll", ["p1", "p 2"])).toBe(
      "/api/polls?filters[documentId][$in][0]=p1&filters[documentId][$in][1]=p%202&fields[0]=question&fields[1]=closesAt&sort[0]=createdAt:desc&pagination[pageSize]=2",
    );
  });
});
