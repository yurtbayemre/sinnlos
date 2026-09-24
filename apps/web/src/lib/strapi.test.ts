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

const { api, strapi } = await import("./strapi");
const { demo } = await import("./demo");

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
  "events.upcoming": () => api.events.upcoming(iso),
  "events.past": () => api.events.past(iso),
  "events.window": () => api.events.window(iso, iso),
  "events.rsvps": () => api.events.rsvps(["doc-1"]),
  "polls.list": () => api.polls.list(),
  "polls.results": () => api.polls.results(1),
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

  it("returns undefined for a 204 without a body", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(strapi("/api/classifieds/1", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("strapi() — DEMO_MODE", () => {
  it("answers from the fixtures without a session read or a fetch", async () => {
    state.demo = true;
    await expect(strapi("/api/departments")).resolves.toEqual(demo("/api/departments"));
    expect(getStrapiTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
