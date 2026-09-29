import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StrapiInit } from "./strapi";

/**
 * Pins the D-DC01 transport contract of strapi() (deep-dive
 * decisions/03-caching.md §3/§9): the web keeps no server-side copy of
 * Strapi responses, so EVERY request — each api.* read and every mutation —
 * goes out with cache: "no-store" and without a `next` key, even when a
 * caller casts its way past the StrapiInit type. The bearer token comes only
 * from getStrapiToken() (lib/session.ts), a 401 redirects to the sign-in page
 * only when a token was sent, and DEMO_MODE never touches the session or the
 * network.
 *
 * `@/lib/session` is mocked (the real module pulls in next-auth), as are
 * `@/lib/config` (DEMO_MODE toggle), `next/navigation` (redirect throws like
 * the real NEXT_REDIRECT) and global fetch. `@/lib/demo` and
 * `@/lib/paginate` are the real modules.
 */
const state = vi.hoisted(() => ({ demo: false }));
const getStrapiTokenMock = vi.fn<() => Promise<string | null>>();
const redirectMock = vi.fn((url: string): never => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/session", () => ({ getStrapiToken: () => getStrapiTokenMock() }));
vi.mock("@/lib/config", () => ({
  STRAPI_URL: "http://cms.test",
  get DEMO_MODE() {
    return state.demo;
  },
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectMock(url) }));
vi.stubGlobal("fetch", fetchMock);

const { api, findPollResults, pollRef, strapi } = await import("./strapi");
const { demo } = await import("./demo");
const { StrapiError } = await import("./strapi-error");

/** A one-page Strapi list body — ends every page walk after one request. */
const onePage = {
  data: [],
  meta: { pagination: { page: 1, pageSize: 100, pageCount: 1, total: 0 } },
};
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every fetch init strapi() produced so far. */
const inits = () => fetchMock.mock.calls.map((c) => c[1]);

function expectNoStore(init: RequestInit) {
  expect(init.cache).toBe("no-store");
  expect("next" in init).toBe(false);
}

/**
 * One call per api.* helper. Keyed by "group.name" so the coverage check
 * below fails when a helper is added without being pinned here.
 */
const iso = "2026-09-24T00:00:00.000Z";
const READS: Record<string, () => Promise<unknown>> = {
  "departments.list": () => api.departments.list(),
  "departments.one": () => api.departments.one("engineering"),
  "teams.list": () => api.teams.list(),
  "teams.one": () => api.teams.one("platform"),
  "wiki.spaces": () => api.wiki.spaces(),
  "wiki.space": () => api.wiki.space("handbook"),
  "wiki.page": () => api.wiki.page("handbook", "onboarding"),
  "announcements.list": () => api.announcements.list(),
  "announcements.requiringAck": () => api.announcements.requiringAck(),
  "events.upcoming": () => api.events.upcoming(iso, iso),
  "events.past": () => api.events.past(iso, iso),
  "events.window": () => api.events.window(iso, iso),
  "events.rsvpSummaries": () => api.events.rsvpSummaries(["doc-1"]),
  "polls.list": () => api.polls.list(),
  "polls.results": () => api.polls.results(1),
  "polls.resultsMany": () => api.polls.resultsMany(["k3m9x0000000000000000001", 7]),
  "documents.list": () => api.documents.list(),
  "kudos.list": () => api.kudos.list(),
  "classifieds.list": () => api.classifieds.list(iso),
  "classifieds.mine": () => api.classifieds.mine(1),
  "classifieds.one": () => api.classifieds.one("1"),
  "quickLinks.list": () => api.quickLinks.list(),
  celebrations: () => api.celebrations(),
};

/** "group.name" for every function reachable in `api` (one level deep). */
function apiHelperNames(): string[] {
  const names: string[] = [];
  for (const [group, value] of Object.entries(api)) {
    if (typeof value === "function") names.push(group);
    else for (const name of Object.keys(value)) names.push(`${group}.${name}`);
  }
  return names.sort();
}

beforeEach(() => {
  state.demo = false;
  getStrapiTokenMock.mockReset();
  getStrapiTokenMock.mockResolvedValue("jwt-abc");
  redirectMock.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jsonResponse(onePage));
});

describe("strapi() — always no-store", () => {
  it("pins every api.* helper in this test", () => {
    expect(Object.keys(READS).sort()).toEqual(apiHelperNames());
  });

  it.each(Object.entries(READS))(
    "%s fetches with cache: no-store and no next key",
    async (_, read) => {
      await read();
      expect(fetchMock).toHaveBeenCalled();
      for (const init of inits()) expectNoStore(init);
    },
  );

  it.each(["POST", "PUT", "DELETE"])("%s mutations are no-store as well", async (method) => {
    await strapi("/api/polls/1/vote", { method, body: JSON.stringify({ optionIndex: 0 }) });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://cms.test/api/polls/1/vote");
    expect(init.method).toBe(method);
    expectNoStore(init);
  });

  it("strips cache/next forced past the StrapiInit type at runtime", async () => {
    const forced = {
      method: "POST",
      // eslint-disable-next-line no-restricted-syntax -- the forbidden option IS the input under test
      cache: "force-cache",
      // eslint-disable-next-line no-restricted-syntax -- the forbidden option IS the input under test
      next: { revalidate: 60, tags: ["polls"] },
    } as unknown as StrapiInit;
    await strapi("/api/polls", forced);
    await api.polls.list();
    for (const init of inits()) expectNoStore(init);
    expect(inits()[0]!.method).toBe("POST");
  });
});

describe("strapi() — bearer token", () => {
  it("takes Authorization from getStrapiToken() and keeps caller headers", async () => {
    await strapi("/api/me", { headers: { "x-extra": "1" } });
    expect(getStrapiTokenMock).toHaveBeenCalledTimes(1);
    const headers = new Headers(inits()[0]!.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt-abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-extra")).toBe("1");
  });

  it("sends no Authorization header without a token", async () => {
    getStrapiTokenMock.mockResolvedValue(null);
    await strapi("/api/celebrations?window=30");
    expect(new Headers(inits()[0]!.headers).has("authorization")).toBe(false);
  });
});

describe("strapi() — responses", () => {
  it("redirects to /sign-in?expired=1 on a 401 when a token was sent", async () => {
    fetchMock.mockImplementation(async () => new Response("expired", { status: 401 }));
    await expect(strapi("/api/me")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/sign-in?expired=1");
  });

  it("throws (no redirect) on a 401 without a token", async () => {
    getStrapiTokenMock.mockResolvedValue(null);
    fetchMock.mockImplementation(async () => new Response("no auth", { status: 401 }));
    await expect(strapi("/api/me")).rejects.toThrow("Strapi 401");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("throws with status and body on any other error", async () => {
    fetchMock.mockImplementation(
      async () => new Response("denied", { status: 403, statusText: "Forbidden" }),
    );
    await expect(strapi("/api/me")).rejects.toThrow("Strapi 403 Forbidden: denied");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("carries the HTTP status on a StrapiError (e.g. the auth throttle's 429, FX11)", async () => {
    fetchMock.mockImplementation(
      async () => new Response("slow down", { status: 429, statusText: "Too Many Requests" }),
    );
    const error = await strapi("/api/auth/change-password", { method: "POST" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StrapiError);
    expect(error).toMatchObject({
      status: 429,
      message: "Strapi 429 Too Many Requests: slow down",
    });
  });

  it("returns undefined for a 204 without a body", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(strapi("/api/classifieds/1", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("api.polls (decision 02)", () => {
  it("lists polls without populating departments (the CMS filters per user)", async () => {
    await api.polls.list();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("http://cms.test/api/polls?");
    expect(url).not.toContain("departments");
    // WD05: no poll consumer renders the author.
    expect(url).not.toContain("populate[author]");
  });

  it("addresses a poll by its documentId, with the row id as the fallback (DA01)", () => {
    expect(pollRef({ id: 7, documentId: "k3m9x0000000000000000001" })).toBe(
      "k3m9x0000000000000000001",
    );
    // Not in Strapi's documentId shape (e.g. the demo fixtures) or missing.
    expect(pollRef({ id: 7, documentId: "demo-poll-1" })).toBe(7);
    expect(pollRef({ id: 7 })).toBe(7);
  });

  it("reads many polls' results in one request per 50, in order (WD04)", async () => {
    const refs = [
      ...Array.from({ length: 51 }, (_, i) => `k3m9x00000000000000000${String(i).padStart(2, "0")}`),
      7,
    ];
    const body = (n: number) => ({
      poll: { id: n, documentId: `doc-${n}`, question: "q", options: ["a"] },
      counts: [0],
      total: 0,
      myVoteIndex: null,
    });
    fetchMock
      .mockImplementationOnce(async () => jsonResponse({ data: [body(1), body(2)] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [body(3)] }));
    const results = await api.polls.resultsMany(refs);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      `http://cms.test/api/poll-results?ids=${refs.slice(0, 50).join(",")}`,
      `http://cms.test/api/poll-results?ids=${refs.slice(50).join(",")}`,
    ]);
    expect(results.map((entry) => entry.poll.id)).toEqual([1, 2, 3]);
    // A body without data reads as no results.
    fetchMock.mockImplementationOnce(async () => jsonResponse({}));
    await expect(api.polls.resultsMany(["k3m9x0000000000000000001"])).resolves.toEqual([]);
  });

  it("finds a poll's entry by its documentId, or by row id for a numeric address", () => {
    const entry = (id: number, documentId?: string) => ({
      poll: { id, documentId, question: "q", options: [] },
      counts: [],
      total: 0,
      myVoteIndex: null,
    });
    const results = [entry(21, "k3m9x0000000000000000001"), entry(7)];
    // Republished since the list read: the documentId still finds it.
    expect(findPollResults(results, "k3m9x0000000000000000001")?.poll.id).toBe(21);
    expect(findPollResults(results, 7)?.poll.id).toBe(7);
    expect(findPollResults(results, 21)?.poll.id).toBe(21);
    expect(findPollResults(results, "k3m9x0000000000000000002")).toBeUndefined();
    expect(findPollResults(results, 8)).toBeUndefined();
  });

  it("reads the results at the address it is given, encoded", async () => {
    await api.polls.results("k3m9x0000000000000000001");
    await api.polls.results(7);
    await api.polls.results("a/b");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://cms.test/api/polls/k3m9x0000000000000000001/results",
      "http://cms.test/api/polls/7/results",
      "http://cms.test/api/polls/a%2Fb/results",
    ]);
  });
});

describe("strapi() — DEMO_MODE", () => {
  it("answers from the fixtures without a session read or a fetch", async () => {
    state.demo = true;
    await expect(strapi("/api/departments")).resolves.toEqual(demo("/api/departments"));
    expect(getStrapiTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves poll results by documentId and by row id alike (DA01)", () => {
    const byId = demo("/api/polls/2/results") as { poll: { id: number } };
    expect(byId.poll.id).toBe(2);
    expect(demo("/api/polls/demo-poll-2/results")).toEqual(byId);
  });
});
