import { NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";
import type { SearchItem } from "@/lib/search-action";

/**
 * The ⌘K search (WD06, web part of FX22). Pinned:
 *   1. query building per role: only staff search people by e-mail (the cms
 *      refuses the clause for everyone else); /api/users pages with
 *      start/limit and an explicit sort; every live kind is bounded; the
 *      term is encoded and cut; the preload never reads /api/users,
 *   2. the typed SearchItem mapper: unique keys (kind + documentId, people
 *      by id), links, subtitles, and rows without what their link needs are
 *      skipped,
 *   3. GET/POST /search: session gate, kinds, role-dependent people query,
 *      per-kind failure isolation, Next.js control flow, no-store, and the
 *      telemetry POST that never fails,
 *   4. the palette's plain functions: response parsing, the session-expiry
 *      signal, the fire-and-forget log, and — with fake timers — the 300 ms
 *      debounce, aborting a superseded request, stale results never
 *      reported, the start signal that drops remembered results (also for
 *      a repeated term), and the settled-term log flush (2 s,
 *      selection/close, never the same term twice).
 *
 * `@/lib/strapi`, the session, the viewer, the config and next-intl/server
 * are mocked; next/navigation is real (its redirect error is the control
 * flow the route must let through).
 */

const strapiMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
const sessionMock = vi.fn<() => Promise<unknown>>();
const viewerMock = vi.fn<() => Promise<{ role: string | null }>>();
const config = vi.hoisted(() => ({ demo: false }));

vi.mock("@/lib/strapi", () => ({
  strapi: (path: string, init?: RequestInit) => strapiMock(path, init),
}));
vi.mock("@/lib/session", () => ({ getSession: () => sessionMock() }));
vi.mock("@/lib/viewer", () => ({ getViewer: () => viewerMock() }));
vi.mock("@/lib/config", () => ({
  get DEMO_MODE() {
    return config.demo;
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async (namespace: string) => (key: string, values?: { date?: string }) =>
    key === "pollCloses" ? `Closes ${values?.date}` : `${namespace}.${key}`,
}));

const search = await import("./search-action");
const palette = await import("@/components/search-command");
const route = await import("@/app/search/route");
const { isPublicPath } = await import("@/proxy");

const STAFF = ["admin_role", "editor", "department_head", "team_lead", "member"];
const NON_STAFF = ["guest", "authenticated", "public", "Member", "", null];

const format: import("./search-action").SearchFormat = {
  eventDate: (iso) => (Number.isNaN(Date.parse(iso)) ? undefined : `date(${iso})`),
  pollCloses: (iso) => (Number.isNaN(Date.parse(iso)) ? undefined : `Closes ${iso}`),
  pollOpen: "Open",
  unknown: "Unknown",
};

const paths = () => strapiMock.mock.calls.map(([path]) => path);

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: [] });
  sessionMock.mockReset();
  sessionMock.mockResolvedValue({ user: { id: 7 } });
  viewerMock.mockReset();
  viewerMock.mockResolvedValue({ role: "guest" });
  config.demo = false;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Query building
// ---------------------------------------------------------------------------

describe("liveSearchPaths: per-role people query, bounded kinds", () => {
  it.each(NON_STAFF)("%j searches people by name and job title only, never by e-mail", (role) => {
    const people = search.liveSearchPaths("ada", role).person;
    expect(people).toContain("filters[$or][0][displayName][$containsi]=ada");
    expect(people).toContain("filters[$or][1][jobTitle][$containsi]=ada");
    expect(people).not.toContain("email");
  });

  it.each(STAFF)("%s also searches people by e-mail", (role) => {
    expect(search.liveSearchPaths("ada", role).person).toContain(
      "filters[$or][2][email][$containsi]=ada",
    );
  });

  it("pages /api/users with start/limit and an explicit sort, never pagination[]", () => {
    for (const role of [...STAFF, ...NON_STAFF]) {
      const people = search.liveSearchPaths("ada", role).person;
      expect(people.startsWith("/api/users?")).toBe(true);
      expect(people).toMatch(/&start=0&limit=5$/);
      expect(people).toContain("sort[0]=displayName:asc&sort[1]=id:asc");
      expect(people).not.toContain("pagination[");
      expect(people).not.toMatch(/fields\[\d+\]=email/);
    }
  });

  it("bounds every other kind to LIVE_LIMIT rows and reads no users", () => {
    const all = search.liveSearchPaths("ada", "member");
    expect(Object.keys(all).sort()).toEqual([...search.LIVE_KINDS].sort());
    for (const kind of search.LIVE_KINDS) {
      if (kind === "person") continue;
      expect(all[kind]).toContain(`pagination[pageSize]=${search.LIVE_LIMIT}`);
      expect(all[kind]).not.toContain("/api/users");
    }
    expect(search.LIVE_LIMIT).toBe(5);
  });

  it("encodes the term and cuts it at MAX_TERM_LENGTH", () => {
    const all = search.liveSearchPaths("a&b[x]=1 ü", "member");
    for (const path of Object.values(all)) {
      expect(path).toContain("a%26b%5Bx%5D%3D1%20%C3%BC");
      expect(path).not.toContain("&b[x]");
    }
    const long = search.liveSearchPaths("x".repeat(500), "guest").event;
    expect(long).toContain(`=${"x".repeat(search.MAX_TERM_LENGTH)}&`);
    expect(long).not.toContain("x".repeat(search.MAX_TERM_LENGTH + 1));
  });

  it("CONTACT_SEARCH_ROLES is exact and fail-closed", () => {
    expect([...search.CONTACT_SEARCH_ROLES].sort()).toEqual([...STAFF].sort());
    for (const role of [...NON_STAFF, undefined, "admin", "EDITOR"]) {
      expect(search.canSearchByEmail(role)).toBe(false);
    }
  });

  it("the preload paths are bounded, field-limited and never read /api/users", () => {
    for (const kind of search.PRELOAD_KINDS) {
      const path = search.preloadPath(kind, 2, "2026-09-28T00:00:00.000Z");
      expect(path).not.toContain("/api/users");
      expect(path).toContain("fields[0]=");
      expect(path).toMatch(/pagination\[pageSize\]=(20|50|100)/);
    }
    expect(search.preloadPath("department", 3, "x")).toContain("pagination[page]=3");
    expect(search.preloadPath("event", 1, "2026-09-28T00:00:00.000Z")).toContain(
      "filters[start][$gte]=2026-09-28T00%3A00%3A00.000Z",
    );
    expect(search.PRELOAD_KINDS).not.toContain("person");
  });
});

// ---------------------------------------------------------------------------
// 2. Mapper
// ---------------------------------------------------------------------------

describe("toSearchItems: the typed mapper", () => {
  it("maps every kind to its link, title and subtitle", () => {
    const map = (kind: import("./search-action").SearchKind, row: Record<string, unknown>) =>
      search.toSearchItems(kind, [row], format)[0];

    expect(
      map("department", {
        id: 1,
        documentId: "d1",
        name: "Engineering",
        slug: "engineering",
        description: "Builds",
      }),
    ).toEqual({
      key: "department:d1",
      kind: "department",
      title: "Engineering",
      subtitle: "Builds",
      href: "/departments/engineering",
    });
    expect(
      map("team", {
        id: 2,
        documentId: "t1",
        name: "Web",
        slug: "web",
        description: "UI",
        department: { name: "Engineering" },
      }),
    ).toEqual({
      key: "team:t1",
      kind: "team",
      title: "Web",
      subtitle: "Engineering · UI",
      href: "/teams/web",
    });
    expect(map("wiki-space", { id: 3, documentId: "s1", name: "HR", slug: "hr" })).toEqual({
      key: "wiki-space:s1",
      kind: "wiki-space",
      title: "HR",
      href: "/wiki/hr",
    });
    expect(
      map("wiki-page", {
        id: 4,
        documentId: "p1",
        title: "Onboarding",
        slug: "onboarding",
        summary: "Week 1",
        space: { name: "HR", slug: "hr" },
      }),
    ).toEqual({
      key: "wiki-page:p1",
      kind: "wiki-page",
      title: "Onboarding",
      subtitle: "HR · Week 1",
      href: "/wiki/hr/onboarding",
    });
    expect(
      map("announcement", {
        id: 5,
        documentId: "a1",
        title: "Hello",
        author: { displayName: "Ada" },
      }),
    ).toEqual({
      key: "announcement:a1",
      kind: "announcement",
      title: "Hello",
      subtitle: "Ada",
      href: "/announcements",
    });
    expect(
      map("event", { id: 6, documentId: "e1", title: "Party", start: "2026-10-05T16:00:00.000Z" }),
    ).toEqual({
      key: "event:e1",
      kind: "event",
      title: "Party",
      subtitle: "date(2026-10-05T16:00:00.000Z)",
      href: "/events",
    });
    expect(map("poll", { id: 7, documentId: "o1", question: "Pizza?" })).toEqual({
      key: "poll:o1",
      kind: "poll",
      title: "Pizza?",
      subtitle: "Open",
      href: "/polls",
    });
    expect(
      map("poll", {
        id: 8,
        documentId: "o2",
        question: "Tea?",
        closesAt: "2026-10-01T00:00:00.000Z",
      })?.subtitle,
    ).toBe("Closes 2026-10-01T00:00:00.000Z");
    expect(map("document", { id: 9, documentId: "f1", title: "Handbook", category: "hr" })).toEqual(
      {
        key: "document:f1",
        kind: "document",
        title: "Handbook",
        subtitle: "hr",
        href: "/documents",
      },
    );
    expect(
      map("person", {
        id: 12,
        documentId: "u12",
        displayName: "Ada",
        jobTitle: "CTO",
        department: { name: "Engineering" },
      }),
    ).toEqual({
      key: "person:u12",
      kind: "person",
      title: "Ada",
      subtitle: "CTO · Engineering",
      href: "/people/12",
    });
  });

  it("gives items with the same link unique keys (the old kind+href key collided)", () => {
    const items = search.toSearchItems(
      "announcement",
      {
        data: [
          { id: 1, documentId: "a1", title: "One" },
          { id: 2, documentId: "a2", title: "Two" },
        ],
      },
      format,
    );
    expect(items.map((item) => item.href)).toEqual(["/announcements", "/announcements"]);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
  });

  it("keys a row without documentId by id and drops duplicate keys", () => {
    const items = search.toSearchItems(
      "document",
      [
        { id: 3, title: "A" },
        { id: 3, title: "A again" },
        { documentId: "x", title: "B" },
      ],
      format,
    );
    expect(items.map((item) => item.key)).toEqual(["document:3", "document:x"]);
  });

  it("skips rows without the fields their link needs", () => {
    expect(search.toSearchItems("department", [{ id: 1, name: "No slug" }], format)).toEqual([]);
    expect(
      search.toSearchItems(
        "wiki-page",
        [{ id: 1, title: "T", slug: "t", space: { name: "No slug" } }],
        format,
      ),
    ).toEqual([]);
    expect(search.toSearchItems("announcement", [{ id: 1, title: "" }], format)).toEqual([]);
    expect(
      search.toSearchItems("person", [{ documentId: "u1", displayName: "No id" }], format),
    ).toEqual([]);
    expect(search.toSearchItems("event", [{ title: "No id" }], format)).toEqual([]);
    expect(search.toSearchItems("poll", [null, 3, "x", [], { id: 1 }], format)).toEqual([]);
  });

  it("accepts a row array or a { data } list; anything else maps to nothing", () => {
    for (const rows of [undefined, null, "x", 42, { data: "x" }, { items: [] }]) {
      expect(search.toSearchItems("document", rows, format)).toEqual([]);
    }
  });

  it("falls back for people without a display name, and drops invalid dates", () => {
    const [byUsername, unknown] = search.toSearchItems(
      "person",
      [{ id: 1, username: "ada" }, { id: 2 }],
      format,
    );
    expect(byUsername).toMatchObject({ title: "ada", href: "/people/1" });
    expect(byUsername.subtitle).toBeUndefined();
    expect(unknown).toMatchObject({ title: "Unknown", href: "/people/2" });
    const [event] = search.toSearchItems(
      "event",
      [{ id: 1, title: "E", start: "not a date" }],
      format,
    );
    expect(event.subtitle).toBeUndefined();
  });

  it("encodes slugs into the link", () => {
    const [space] = search.toSearchItems(
      "wiki-space",
      [{ id: 1, name: "S", slug: "a b/ä" }],
      format,
    );
    expect(space.href).toBe("/wiki/a%20b%2F%C3%A4");
  });
});

// ---------------------------------------------------------------------------
// 3. GET / POST /search
// ---------------------------------------------------------------------------

const get = (query: string) => route.GET(new NextRequest(`http://web.test/search${query}`));
const post = (
  body: unknown,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
) =>
  route.POST(
    new NextRequest("http://web.test/search", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

/** A row per live kind, answered by path. */
function answerLiveSearch() {
  strapiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/users")) return [{ id: 12, displayName: "Ada" }];
    if (path.startsWith("/api/announcements"))
      return { data: [{ id: 1, documentId: "a1", title: "Ada news" }] };
    if (path.startsWith("/api/wiki-pages"))
      return {
        data: [{ id: 2, documentId: "p1", title: "Ada page", slug: "ada", space: { slug: "hr" } }],
      };
    if (path.startsWith("/api/documents"))
      return { data: [{ id: 3, documentId: "f1", title: "Ada doc" }] };
    if (path.startsWith("/api/events"))
      return { data: [{ id: 4, documentId: "e1", title: "Ada event" }] };
    if (path.startsWith("/api/polls"))
      return { data: [{ id: 5, documentId: "o1", question: "Ada?" }] };
    return { data: [] };
  });
}

describe("GET /search", () => {
  it("answers 401 without a session, before any Strapi read", async () => {
    sessionMock.mockResolvedValue(null);
    const res = await get("?q=ada");
    expect(res.status).toBe(401);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown kind or without q and kind", async () => {
    expect((await get("?kind=person")).status).toBe(400);
    expect((await get("?kind=users")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("preloads one kind per request, uncached", async () => {
    strapiMock.mockResolvedValue({
      data: [{ id: 1, documentId: "d1", name: "Engineering", slug: "engineering" }],
      meta: { pagination: { page: 1, pageCount: 1 } },
    });
    const res = await get("?kind=department");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      items: [
        {
          key: "department:d1",
          kind: "department",
          title: "Engineering",
          href: "/departments/engineering",
        },
      ],
    });
    expect(paths()).toHaveLength(1);
    expect(paths()[0]).toMatch(/^\/api\/departments\?fields\[0\]=name&/);
    expect(viewerMock).not.toHaveBeenCalled();
  });

  it("walks every page of the complete kinds", async () => {
    strapiMock
      .mockResolvedValueOnce({
        data: [{ id: 1, documentId: "t1", name: "A", slug: "a" }],
        meta: { pagination: { page: 1, pageCount: 2 } },
      })
      .mockResolvedValueOnce({
        data: [{ id: 2, documentId: "t2", name: "B", slug: "b" }],
        meta: { pagination: { page: 2, pageCount: 2 } },
      });
    const body = (await (await get("?kind=team")).json()) as { items: SearchItem[] };
    expect(body.items.map((item) => item.key)).toEqual(["team:t1", "team:t2"]);
    expect(paths().map((path) => /pagination\[page\]=(\d+)/.exec(path)?.[1])).toEqual(["1", "2"]);
  });

  it("answers a term under 2 characters with no items and no reads", async () => {
    const res = await get("?q=a");
    expect(await res.json()).toEqual({ items: [] });
    expect(strapiMock).not.toHaveBeenCalled();
    expect(viewerMock).not.toHaveBeenCalled();
  });

  it("searches as guest without the e-mail clause, in LIVE_KINDS order", async () => {
    answerLiveSearch();
    const body = (await (await get("?q=ada")).json()) as { items: SearchItem[] };
    expect(body.items.map((item) => item.kind)).toEqual([
      "announcement",
      "wiki-page",
      "document",
      "event",
      "poll",
      "person",
    ]);
    const people = paths().find((path) => path.startsWith("/api/users"));
    expect(people).toBe(search.liveSearchPaths("ada", "guest").person);
    expect(people).not.toContain("email");
    expect(paths()).toHaveLength(6);
  });

  it("searches as member with the e-mail clause", async () => {
    viewerMock.mockResolvedValue({ role: "member" });
    answerLiveSearch();
    await get("?q=ada");
    expect(paths().find((path) => path.startsWith("/api/users"))).toContain(
      "[email][$containsi]=ada",
    );
  });

  it("an unreadable viewer (role null) searches without the e-mail clause", async () => {
    viewerMock.mockResolvedValue({ role: null });
    answerLiveSearch();
    await get("?q=ada");
    expect(paths().find((path) => path.startsWith("/api/users"))).not.toContain("email");
  });

  it("isolates a failed kind (a guest 403, a cms error)", async () => {
    answerLiveSearch();
    const answer = strapiMock.getMockImplementation();
    strapiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/announcements")) throw new StrapiError(403, "Forbidden", "");
      if (path.startsWith("/api/polls")) throw new Error("boom");
      return answer?.(path);
    });
    const body = (await (await get("?q=ada")).json()) as { items: SearchItem[] };
    expect(body.items.map((item) => item.kind)).toEqual([
      "wiki-page",
      "document",
      "event",
      "person",
    ]);
  });

  it("lets the expired-session redirect through", async () => {
    let redirectError: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (error) {
      redirectError = error;
    }
    strapiMock.mockRejectedValue(redirectError);
    await expect(get("?q=ada")).rejects.toBe(redirectError);
  });

  it("needs no session in DEMO_MODE", async () => {
    config.demo = true;
    sessionMock.mockResolvedValue(null);
    expect((await get("?kind=poll")).status).toBe(200);
  });

  it("is not public in proxy.ts", () => {
    expect(isPublicPath("/search")).toBe(false);
  });
});

describe("POST /search (telemetry)", () => {
  it("logs the settled term and answers 204", async () => {
    strapiMock.mockResolvedValue({});
    const res = await post({ term: "  Urlaub  ", count: 3 });
    expect(res.status).toBe(204);
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [path, init] = strapiMock.mock.calls[0];
    expect(path).toBe("/api/search-logs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ data: { term: "Urlaub", resultCount: 3 } });
  });

  it("ignores a cross-site request, a malformed body and a short term", async () => {
    expect(
      (await post({ term: "Urlaub", count: 1 }, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(204);
    expect((await post("{not json")).status).toBe(204);
    expect((await post({ count: 1 })).status).toBe(204);
    expect((await post({ term: "U", count: 1 })).status).toBe(204);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("answers 204 when the log write fails", async () => {
    strapiMock.mockRejectedValue(new StrapiError(500, "Internal Server Error", ""));
    expect((await post({ term: "Urlaub", count: 1 })).status).toBe(204);
  });

  it("answers 401 without a session", async () => {
    sessionMock.mockResolvedValue(null);
    expect((await post({ term: "Urlaub", count: 1 })).status).toBe(401);
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("logSearch", () => {
  it("never throws for a failed write, clamps the count and cuts the term", async () => {
    strapiMock.mockRejectedValue(new Error("down"));
    await expect(search.logSearch("Urlaub", 1)).resolves.toBeUndefined();
    strapiMock.mockResolvedValue({});
    await search.logSearch(`  ${"y".repeat(300)} `, Number.NaN);
    await search.logSearch("abc", -5.7);
    const bodies = strapiMock.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { data: { term: "y".repeat(120), resultCount: 0 } },
      { data: { term: "abc", resultCount: 0 } },
    ]);
  });

  it("rethrows Next.js control flow (an expired session's redirect)", async () => {
    let redirectError: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (error) {
      redirectError = error;
    }
    strapiMock.mockRejectedValue(redirectError);
    await expect(search.logSearch("Urlaub", 1)).rejects.toBe(redirectError);
  });
});

// ---------------------------------------------------------------------------
// 4. The palette's functions
// ---------------------------------------------------------------------------

describe("palette: kinds and response parsing", () => {
  it("preloads exactly the server's PRELOAD_KINDS and knows exactly its SEARCH_KINDS", () => {
    expect([...palette.PALETTE_PRELOAD_KINDS]).toEqual([...search.PRELOAD_KINDS]);
    expect([...palette.PALETTE_KINDS].sort()).toEqual([...search.SEARCH_KINDS].sort());
  });

  it("builds encoded /search URLs", () => {
    expect(palette.searchUrl("a&b c")).toBe("/search?q=a%26b%20c");
    expect(palette.preloadUrl("wiki-page")).toBe("/search?kind=wiki-page");
  });

  it("parses items and drops malformed entries, duplicates and foreign links", () => {
    const ok = { key: "poll:1", kind: "poll", title: "P", href: "/polls", subtitle: "Open" };
    expect(
      palette.parseSearchItems({
        items: [
          ok,
          { ...ok },
          { ...ok, key: "x:1", kind: "user" },
          { ...ok, key: "x:2", title: "" },
          { ...ok, key: "x:3", href: "//evil.test/x" },
          { ...ok, key: "x:4", href: "/\\evil.test" },
          { ...ok, key: "x:5", href: "https://evil.test" },
          { ...ok, key: "x:6", href: "javascript:alert(1)" },
          { ...ok, key: "x:7", subtitle: 3 },
          null,
          "x",
        ],
      }),
    ).toEqual([ok, { key: "x:7", kind: "poll", title: "P", href: "/polls" }]);
    for (const body of [null, [], { items: "x" }, "x"])
      expect(palette.parseSearchItems(body)).toEqual([]);
  });
});

describe("palette: fetchSearchItems", () => {
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
  beforeEach(() => fetchMock.mockReset());

  it("GETs no-store, without following redirects, with the abort signal", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ items: [{ key: "poll:1", kind: "poll", title: "P", href: "/polls" }] }),
    );
    const controller = new AbortController();
    const items = await palette.fetchSearchItems("/search?q=ab", controller.signal, fetchMock);
    expect(items).toEqual([{ key: "poll:1", kind: "poll", title: "P", href: "/polls" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/search?q=ab");
    expect(init).toMatchObject({
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  });

  it.each([307, 302, 401])("signals an expired session on %i", async (status) => {
    fetchMock.mockResolvedValue(
      new Response(null, { status, headers: status === 401 ? {} : { location: "/sign-in" } }),
    );
    await expect(
      palette.fetchSearchItems("/search?q=ab", new AbortController().signal, fetchMock),
    ).rejects.toBeInstanceOf(palette.SessionExpiredError);
  });

  it("fails on any other error status", async () => {
    fetchMock.mockResolvedValue(new Response("x", { status: 500 }));
    const attempt = palette.fetchSearchItems(
      "/search?q=ab",
      new AbortController().signal,
      fetchMock,
    );
    await expect(attempt).rejects.toThrow("GET /search?q=ab answered 500");
    await expect(attempt).rejects.not.toBeInstanceOf(palette.SessionExpiredError);
  });
});

describe("palette: sendSearchLog", () => {
  it("POSTs the term as keepalive JSON", () => {
    const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    palette.sendSearchLog("Urlaub", 3, fetchMock);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/search");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(String(init.body))).toEqual({ term: "Urlaub", count: 3 });
  });

  it("never throws, whether fetch throws or rejects", async () => {
    expect(() =>
      palette.sendSearchLog("a", 1, () => {
        throw new TypeError("offline");
      }),
    ).not.toThrow();
    const rejecting = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(() => palette.sendSearchLog("a", 1, rejecting)).not.toThrow();
    await Promise.resolve();
    expect(rejecting).toHaveBeenCalledTimes(1);
  });
});

describe("palette: createSearchScheduler (fake timers)", () => {
  interface Deferred {
    resolve(items: SearchItem[]): void;
    reject(error: unknown): void;
  }

  function setup() {
    const requests: Array<{ term: string; signal: AbortSignal } & Deferred> = [];
    const results: Array<[string, number]> = [];
    const logs: Array<[string, number]> = [];
    const expired = vi.fn();
    const scheduler = palette.createSearchScheduler({
      search: (term, signal) =>
        new Promise<SearchItem[]>((resolve, reject) =>
          requests.push({ term, signal, resolve, reject }),
        ),
      onResults: (term, items) => results.push([term, items.length]),
      onSessionExpired: expired,
      log: (term, count) => logs.push([term, count]),
    });
    return { scheduler, requests, results, logs, expired };
  }

  const items = (n: number): SearchItem[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `poll:${i}`,
      kind: "poll",
      title: `P${i}`,
      href: "/polls",
    }));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("debounces by 300 ms and restarts the wait on every keystroke", async () => {
    const { scheduler, requests } = setup();
    scheduler.query("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(0); // under 2 characters: no request

    scheduler.query("ad");
    await vi.advanceTimersByTimeAsync(200);
    scheduler.query("ada");
    await vi.advanceTimersByTimeAsync(299);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests.map((r) => r.term)).toEqual(["ada"]);
  });

  it("aborts a superseded request and never reports its results", async () => {
    const { scheduler, requests, results } = setup();
    scheduler.query("ad");
    await vi.advanceTimersByTimeAsync(300);
    scheduler.query("ada");
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].resolve(items(4)); // arrives late
    await vi.advanceTimersByTimeAsync(300);
    requests[1].resolve(items(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([["ada", 2]]);
  });

  it("signals every scheduled search, a repeated term included, before its results", async () => {
    const events: string[] = [];
    const pending: Deferred[] = [];
    const scheduler = palette.createSearchScheduler({
      search: () =>
        new Promise<SearchItem[]>((resolve, reject) => pending.push({ resolve, reject })),
      onStart: (term) => events.push(`start ${term}`),
      onResults: (term, found) => events.push(`results ${term} ${found.length}`),
      onSessionExpired: vi.fn(),
      log: vi.fn(),
    });
    scheduler.query("a"); // under 2 characters: nothing scheduled
    scheduler.query("ada");
    await vi.advanceTimersByTimeAsync(300);
    pending[0].resolve(items(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["start ada", "results ada 3"]);

    // "ada" → "ad" → "ada" inside the debounce: the palette drops the
    // remembered "ada" items at once, not when the new answer arrives.
    scheduler.query("ad");
    scheduler.query("ada");
    expect(events.slice(2)).toEqual(["start ad", "start ada"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(pending).toHaveLength(2);
    pending[1].resolve(items(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.slice(2)).toEqual(["start ad", "start ada", "results ada 2"]);

    scheduler.query(""); // clearing the box schedules nothing
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(5);
  });

  it("clearing the box below 2 characters cancels the pending search", async () => {
    const { scheduler, requests, results } = setup();
    scheduler.query("ada");
    await vi.advanceTimersByTimeAsync(300);
    scheduler.query("");
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].resolve(items(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(results).toEqual([]);
  });

  it("logs a term only after 2 s of stability, with its result count", async () => {
    const { scheduler, requests, logs } = setup();
    scheduler.query("urlaub");
    await vi.advanceTimersByTimeAsync(300);
    requests[0].resolve(items(3));
    await vi.advanceTimersByTimeAsync(1999);
    expect(logs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(logs).toEqual([["urlaub", 3]]);
  });

  it("logs only the settled term, not the prefixes typed on the way", async () => {
    const { scheduler, requests, logs } = setup();
    for (const term of ["of", "off", "offs", "offsite"]) {
      scheduler.query(term);
      await vi.advanceTimersByTimeAsync(300);
      requests[requests.length - 1].resolve(items(term.length));
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(logs).toEqual([["offsite", 7]]);
  });

  it("flushLog (selection, close) logs at once, and never the same term twice in a row", async () => {
    const { scheduler, requests, logs } = setup();
    scheduler.query("urlaub");
    await vi.advanceTimersByTimeAsync(300);
    requests[0].resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.flushLog();
    expect(logs).toEqual([["urlaub", 0]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(logs).toHaveLength(1);

    scheduler.query("urlaub");
    await vi.advanceTimersByTimeAsync(300);
    requests[1].resolve([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(logs).toHaveLength(1);

    scheduler.query("kantine");
    await vi.advanceTimersByTimeAsync(300);
    requests[2].resolve(items(1));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.flushLog();
    expect(logs).toEqual([
      ["urlaub", 0],
      ["kantine", 1],
    ]);
  });

  it("settles a failed search as no results, without logging it", async () => {
    const { scheduler, requests, results, logs } = setup();
    scheduler.query("urlaub");
    await vi.advanceTimersByTimeAsync(300);
    requests[0].reject(new Error("500"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(results).toEqual([["urlaub", 0]]);
    expect(logs).toEqual([]);
  });

  it("reports an expired session instead of results", async () => {
    const { scheduler, requests, results, logs, expired } = setup();
    scheduler.query("urlaub");
    await vi.advanceTimersByTimeAsync(300);
    requests[0].reject(new palette.SessionExpiredError());
    await vi.advanceTimersByTimeAsync(3000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("dispose flushes the pending log, aborts the request in flight and ignores later terms", async () => {
    const { scheduler, requests, logs } = setup();
    scheduler.query("urlaub");
    await vi.advanceTimersByTimeAsync(300);
    requests[0].resolve(items(2));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.query("kantine");
    await vi.advanceTimersByTimeAsync(300);
    scheduler.dispose();
    expect(logs).toEqual([["urlaub", 2]]);
    expect(requests[1].signal.aborted).toBe(true);
    scheduler.query("again");
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(2);
  });
});
